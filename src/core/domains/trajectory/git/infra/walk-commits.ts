/**
 * Phase 2 of buildChunkChurnMapUncached: commit iteration loop.
 *
 * Fetches commits via CLI pathspec, performs parallel blob reads +
 * structuredPatch to extract hunks, then per-file sequentially maps hunks to
 * chunks with offset tracking — mutating the per-chunk accumulators in place.
 */

import { structuredPatch } from "diff";

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type {
  BlobBatchReader,
  CommitInfo,
  CommitWithChangedFiles,
  FileChurnData,
} from "../../../../adapters/vcs/types.js";
import type { CommitDiffHunk, CommitDiffMemoPort } from "../../../../contracts/types/commit-diff-memo.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { buildBugFixShaSet } from "./merge-branch-resolver.js";
import { isBugFixCommitOrBranch, type ChunkAccumulator, type SquashOptions } from "./metrics.js";
import { applyOffsets, changedRowsInRange, mapHunksToChunks, type AdjustedRange } from "./offset-tracker.js";
import { resolveHeadPaths, sliceCommitsFollowingRenames, type HeadAttributedChangedPath } from "./rename-following.js";
import { extractTaskIds } from "./utils.js";

/** Duck type for injected concurrency limiter — matches infra/semaphore.ts Semaphore shape. */
export interface ChunkConcurrencySemaphore {
  acquire: () => Promise<() => void>;
}

/** Structural hunk shape shared with the diff memo (positions of one structuredPatch hunk). */
export type WalkCommitDiffHunk = CommitDiffHunk;

/**
 * Duck type for the run-scoped (commitSha, filePath) → hunks memo — matches
 * infra/commit-diff-memo.ts CommitDiffMemo (bd tea-rags-mcp-7gnre). An empty
 * array is a valid memoized value (identical or empty blobs / patch failure);
 * `undefined` means never computed.
 */
export type WalkCommitDiffMemo = CommitDiffMemoPort;

/**
 * Duck type for the run-scoped commit-discovery matrix — matches infra
 * commit-discovery.ts GitCommitDiscovery (bd tea-rags-mcp-82va1).
 */
export interface WalkCommitDiscovery {
  commitsForFiles: (filePaths: string[]) => Promise<CommitWithChangedFiles[]>;
  getBugFixShas: () => Promise<Set<string>>;
}

/** Per-walk instrumentation snapshot (bd tea-rags-mcp-iqpuu). */
export interface ChunkChurnWalkStats {
  /** Files in this walk's (relativized) chunk map — the batch size. */
  files: number;
  /** Commits in the discovery slice / pathspec result. */
  commits: number;
  /** Semaphore acquisitions (one per commit entry processed). */
  holdCount: number;
  /** Total ms spent waiting for a limiter slot across all holds. */
  semWaitMs: number;
  blobReads: number;
  patches: number;
  memoHits: number;
  /** Whole uncached build: discovery slice -> walk -> overlay assembly. */
  wallMs: number;
}

export interface WalkCommitsResult {
  /** Number of commits returned by `getCommitsByPathspec`. */
  commitCount: number;
  /** Semaphore acquisitions — one per commit entry processed. */
  holdCount: number;
  /** Total ms spent waiting for a limiter slot across all holds. */
  semWaitMs: number;
  blobReads: number;
  patchCalls: number;
  memoHits: number;
}

export interface WalkCommitsOptions {
  /** Repo-scoped VCS adapter — pathspec discovery + self-spawned blob reader. */
  adapter: VcsGitAdapter;
  relativeChunkMap: Map<string, ChunkLookupEntry[]>;
  accumulators: Map<string, ChunkAccumulator>;
  isoGitCache: Record<string, unknown>;
  concurrency: number;
  maxAgeMonths: number;
  chunkTimeoutMs: number;
  externalSemaphore?: ChunkConcurrencySemaphore;
  /**
   * Optional reference squashOpts so signature parity with the original is
   * preserved for callers that mutate later phases; not consumed here.
   */
  squashOpts?: SquashOptions;
  fileChurnDataMap?: Map<string, FileChurnData>;
  /**
   * Run-scoped, caller-owned `git cat-file --batch` reader. When provided, the
   * walk reuses it (pack already open) and does NOT close it — the caller owns
   * the lifecycle. Absent ⇒ the walk spawns its own and closes it in `finally`.
   * Amortizes the per-batch pack-open across all batches of a run (kc93).
   */
  blobReader?: BlobBatchReader;
  /**
   * Run-scoped, caller-owned (commitSha, filePath) → hunks memo shared across
   * the per-batch walks of one indexing run (bd tea-rags-mcp-7gnre). A memo
   * hit skips both blob reads and structuredPatch for that (commit, file); a
   * miss computes then memoizes — including empty results, so known-empty
   * diffs are never recomputed. The walk never clears it — lifecycle belongs
   * to the caller (ChunkPhase drops it at drain).
   */
  diffMemo?: WalkCommitDiffMemo;
  /**
   * Run-scoped commit-discovery matrix (bd tea-rags-mcp-82va1). When present,
   * the walk slices the ONE run-scoped commitSha → changedFiles matrix via
   * `commitsForFiles` instead of running its own per-batch pathspec log, and
   * consumes the ONE shared bugFixShaSet via `getBugFixShas`. Lifecycle is
   * owned by ChunkPhase (lazy create at first dispatch, dropped at drain).
   * Absent ⇒ legacy per-batch discovery (recovery / backfill paths).
   */
  commitDiscovery?: WalkCommitDiscovery;
}

/** One commit's hunks for one file, carried from Phase 1 to Phase 2. */
interface CommitHunkData {
  commit: CommitInfo;
  hunks: WalkCommitDiffHunk[];
  isBugFix: boolean;
  taskIds: string[];
  /**
   * The commit's position in the discovery's log order (0 = newest). Phase 2
   * walks a file's commits by it — never by `commit.timestamp`, the AUTHOR date,
   * which a rebased or backdated commit sets below the commits it sits on and
   * which ties for commits made within one second (bd tea-rags-mcp-xi2r9).
   */
  logIndex: number;
}

/** Commits to walk plus the bug-fix SHA set their classification needs. */
interface CommitDiscoveryResult {
  /** Newest → oldest (log order) — `resolveHeadPaths` depends on it. */
  commitEntries: CommitWithChangedFiles[];
  bugFixShas: Set<string>;
}

/** Phase-1 output: raw hunks per file plus the instrumentation counters. */
interface HunkCollection {
  fileHunkMap: Map<string, CommitHunkData[]>;
  blobReads: number;
  patchCalls: number;
  memoHits: number;
  skippedEmptyBlobs: number;
  holdCount: number;
  semWaitMs: number;
}

/**
 * Phase 0 — resolve which commits this walk covers.
 *
 * Two sources with identical failure semantics (a broken discovery ⇒ no churn
 * for this batch, never a thrown walk): the run-scoped discovery matrix sliced
 * in memory (bd tea-rags-mcp-82va1), or a per-batch CLI pathspec log. There is
 * no isomorphic-git fallback — `git.log` OOMs on large repos.
 */
async function discoverCommits(
  opts: WalkCommitsOptions,
  filePaths: string[],
  sinceDate: Date,
  startedAt: number,
): Promise<CommitDiscoveryResult> {
  if (opts.commitDiscovery) {
    // The bugFixShaSet is the ONE shared set over ALL matrix commits.
    const discovery = opts.commitDiscovery;
    let commitEntries: CommitWithChangedFiles[];
    try {
      // Pre-rename commits name the file by an old path, which a HEAD-keyed
      // slice never contains — widen it (bd tea-rags-mcp-z8w16).
      commitEntries = await sliceCommitsFollowingRenames(async (paths) => discovery.commitsForFiles(paths), filePaths);
    } catch (error) {
      if (isDebug()) {
        console.error(
          `[ChunkChurn] discovery slice failed, skipping chunk churn:`,
          error instanceof Error ? error.message : error,
        );
      }
      commitEntries = [];
    }
    const bugFixShas = await discovery.getBugFixShas().catch(() => new Set<string>());
    if (isDebug()) {
      console.error(
        `[ChunkChurn] discovery slice: ${commitEntries.length} commits for ${filePaths.length} files in ${Date.now() - startedAt}ms`,
      );
    }
    return { commitEntries, bugFixShas };
  }

  // Use CLI pathspec filtering — only fetches commits touching our files.
  let commitEntries: CommitWithChangedFiles[];
  try {
    // Same widening as the matrix branch. A pathspec restricts rename detection
    // to the paths it names, so a HEAD-only pathspec rarely surfaces the rename
    // row that would widen it — this legacy (recovery / backfill) path follows
    // fewer renames than the matrix one.
    commitEntries = await sliceCommitsFollowingRenames(
      async (paths) => opts.adapter.getCommitsByPathspec(sinceDate, paths, opts.chunkTimeoutMs),
      filePaths,
    );
  } catch (error) {
    if (isDebug()) {
      console.error(
        `[ChunkChurn] CLI pathspec failed, skipping chunk churn:`,
        error instanceof Error ? error.message : error,
      );
    }
    commitEntries = [];
  }
  if (isDebug()) {
    console.error(
      `[ChunkChurn] CLI pathspec: ${commitEntries.length} commits for ${filePaths.length} files in ${Date.now() - startedAt}ms`,
    );
  }
  // Build bug-fix SHA set from merge branch prefixes.
  return { commitEntries, bugFixShas: buildBugFixShaSet(commitEntries.map((e) => e.commit)) };
}

/**
 * Bounded concurrency: the coordinator-shared external semaphore when supplied,
 * else an internal one. Unified shape — `acquire()` returns a per-call release
 * closure.
 */
function createAcquire(concurrency: number, externalSemaphore?: ChunkConcurrencySemaphore): () => Promise<() => void> {
  if (externalSemaphore) return async () => externalSemaphore.acquire();
  let activeCount = 0;
  const queue: (() => void)[] = [];
  const makeRelease = () => (): void => {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      activeCount--;
    }
  };
  return async (): Promise<() => void> => {
    if (activeCount < concurrency) {
      activeCount++;
      return makeRelease();
    }
    return new Promise<() => void>((resolve) => {
      queue.push(() => {
        resolve(makeRelease());
      });
    });
  };
}

/**
 * Phase 1 — parallel blob reads + structuredPatch → raw hunk data.
 *
 * One persistent `git cat-file --batch` process serves the whole walk: the
 * chunk-churn does tens of thousands of blob reads, and the earlier per-call
 * `git cat-file blob` spawned a git process EACH time (fork + reopen the pack
 * .idx), dominating wall time. See `.claude/rules/git-cat-file-batch.md`.
 *
 * kc93: a run-scoped reader may be INJECTED by the caller (ChunkPhase) so the
 * SAME process is shared across every per-batch walk of a run — the pack is
 * opened once for the whole run, not once per batch. When injected, the caller
 * owns the lifecycle; only a reader we spawned ourselves is closed here.
 */
async function collectHunksPerFile(
  opts: WalkCommitsOptions,
  discovery: CommitDiscoveryResult,
): Promise<HunkCollection> {
  const { adapter, relativeChunkMap, diffMemo } = opts;
  const acquire = createAcquire(opts.concurrency, opts.externalSemaphore);
  const ownsReader = opts.blobReader === undefined;
  const blobReader = opts.blobReader ?? adapter.createBlobBatchReader();
  const fileHunkMap = new Map<string, CommitHunkData[]>();
  const out: HunkCollection = {
    fileHunkMap,
    blobReads: 0,
    patchCalls: 0,
    memoHits: 0,
    skippedEmptyBlobs: 0,
    holdCount: 0,
    semWaitMs: 0,
  };

  /**
   * One (commit, file) pair: memo lookup, else two blob reads + structuredPatch.
   * Blobs and the memo are addressed by the path the COMMIT used (`filePath`);
   * the chunk map and `fileHunkMap` by the HEAD path the row resolved to —
   * they differ for every commit made before a rename (bd tea-rags-mcp-z8w16).
   */
  const collectOneFile = async (
    { changed, headPath }: HeadAttributedChangedPath,
    commit: CommitInfo,
    parentOid: string | null,
    isBugFix: boolean,
    commitTaskIds: string[],
    logIndex: number,
  ): Promise<void> => {
    const filePath = changed.path;
    // A file past maxFileLines never reaches here: `buildAccumulators` drops it
    // from the map, so it has neither hunks nor an overlay (bd tea-rags-mcp-2brzq).
    if (!relativeChunkMap.has(headPath)) return;

    let hunks = diffMemo?.get(commit.sha, filePath);
    if (hunks === undefined) {
      // A rename commit's file exists at the parent under its OLD name only, so
      // the parent side MUST be read there (bd tea-rags-mcp-0dwsn). Reading it
      // at the post-rename path returns "" and structuredPatch then reports one
      // hunk spanning the whole file, crediting the rename to EVERY chunk —
      // the over-count that mirrors the under-count this fix removes.
      //
      // A root commit has no parent: its side is the empty tree, so the commit
      // ADDS every line it holds — what `git log -L` credits it with, and what
      // a non-root commit adding a file already gets (its parent blob reads
      // ""). Skipping it dropped the creating commit of every file born in the
      // root commit (bd tea-rags-mcp-z8w16).
      const [oldContent, newContent] = await Promise.all([
        parentOid === null ? "" : blobReader.read(parentOid, changed.previousPath ?? filePath),
        blobReader.read(commit.sha, filePath),
      ]);
      out.blobReads += parentOid === null ? 1 : 2;

      if (!oldContent && !newContent) {
        out.skippedEmptyBlobs++;
        diffMemo?.set(commit.sha, filePath, []);
        return;
      }

      try {
        // Zero context: a hunk spans only the rows this commit added or
        // removed. The default 4 context rows credited every chunk within 4
        // rows of an edit with a commit `git log -L` never lists for it (bd
        // tea-rags-mcp-z3cnd); `changedRowsInRange` reads these hunks as-is.
        const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "", { context: 0 });
        ({ hunks } = patch);
        out.patchCalls++;
      } catch {
        // Deterministic for identical content — memoize the failure as empty
        // so later walks don't re-read + re-throw.
        diffMemo?.set(commit.sha, filePath, []);
        return;
      }
      diffMemo?.set(commit.sha, filePath, hunks);
    } else {
      out.memoHits++;
    }

    if (hunks.length === 0) return;

    // Collect into fileHunkMap (safe: JS single-threaded between awaits)
    let list = fileHunkMap.get(headPath);
    if (!list) {
      list = [];
      fileHunkMap.set(headPath, list);
    }
    list.push({ commit, hunks, isBugFix, taskIds: commitTaskIds, logIndex });
  };

  const collectHunks = async (
    entry: CommitWithChangedFiles,
    attributedRows: HeadAttributedChangedPath[],
    logIndex: number,
  ): Promise<void> => {
    const acquireStart = Date.now();
    const release = await acquire();
    out.semWaitMs += Date.now() - acquireStart;
    out.holdCount++;
    try {
      const { commit } = entry;

      // Match on the HEAD path each row resolved to — the chunk map is keyed on
      // HEAD paths. A rename row names the post-rename path (bd
      // tea-rags-mcp-0dwsn); a row older than a rename names a path the alias
      // map resolves forward (bd tea-rags-mcp-z8w16).
      const relevantFiles = attributedRows.filter((row) => relativeChunkMap.has(row.headPath));
      if (relevantFiles.length === 0) return;

      const isBugFix = isBugFixCommitOrBranch(commit.body, commit.sha, discovery.bugFixShas);
      const commitTaskIds = extractTaskIds(commit.body);

      // First-parent oid straight from CommitInfo.parents — already parsed
      // from `%P` by the git log parsers and validated by the discovery store,
      // so no per-commit `git rev-parse <sha>^` spawn (bd tea-rags-mcp-iqpuu;
      // ~3900 spawns/run removed). Root commit (parents [] or absent — the
      // optional chain covers loose test fixtures) → null → diffed against
      // the empty tree.
      const parentOid = entry.commit.parents?.[0] ?? null;

      await Promise.all(
        relevantFiles.map(async (row) => collectOneFile(row, commit, parentOid, isBugFix, commitTaskIds, logIndex)),
      );
    } finally {
      release();
    }
  };

  try {
    // Resolved sequentially, newest → oldest, BEFORE the parallel fan-out: the
    // alias map is rewritten at each rename commit, so a row's HEAD path
    // depends on every newer commit already having been seen.
    const attributed = resolveHeadPaths(discovery.commitEntries);
    await Promise.all(discovery.commitEntries.map(async (entry, i) => collectHunks(entry, attributed[i], i)));
  } finally {
    // Tear the cat-file process down once all blob reads are done (Phase 2 maps
    // hunks → chunks in-memory, no further git reads) — but ONLY if we spawned
    // it. A caller-injected (run-scoped) reader is closed by the caller.
    if (ownsReader) await blobReader.close();
  }
  return out;
}

/**
 * Phase 2 — sequential per file, parallel across files: walk this file's
 * commits newest→oldest, mapping each commit's hunks onto chunk ranges that are
 * offset-adjusted backwards as the walk moves into older commits, and mutate the
 * per-chunk accumulators in place.
 */
function applyFileHunksToAccumulators(
  filePath: string,
  hunkDataList: CommitHunkData[],
  relativeChunkMap: Map<string, ChunkLookupEntry[]>,
  accumulators: Map<string, ChunkAccumulator>,
): void {
  const entries = relativeChunkMap.get(filePath);
  if (!entries) return;

  // Newest → oldest in HISTORY order for backward offset tracking: a commit's
  // hunks are read against ranges carried back through every commit above it,
  // which author dates do not order (see `CommitHunkData#logIndex`).
  hunkDataList.sort((a, b) => a.logIndex - b.logIndex);

  // Init adjusted ranges from HEAD chunk positions
  let adjustedRanges: AdjustedRange[] = entries.map((e) => ({
    chunkId: e.chunkId,
    start: e.startLine,
    end: e.endLine,
  }));

  for (const { commit, hunks, isBugFix, taskIds } of hunkDataList) {
    // Map hunks to chunks using current adjusted ranges
    const affectedChunkIds = mapHunksToChunks(hunks, adjustedRanges);

    // relativeChurn inputs: the rows each hunk changed inside each chunk — the
    // same predicate `mapHunksToChunks` credits commits by.
    for (const hunk of hunks) {
      for (const r of adjustedRanges) {
        const changed = changedRowsInRange(hunk, r);
        const acc = changed && accumulators.get(r.chunkId);
        if (!changed || !acc) continue;
        acc.linesAdded += changed.added;
        acc.linesDeleted += changed.deleted;
      }
    }

    // Accumulate per-chunk stats
    for (const chunkId of affectedChunkIds) {
      const acc = accumulators.get(chunkId);
      if (!acc) continue;
      acc.commitShas.add(commit.sha);
      acc.authors.add(commit.author);
      acc.commitTimestamps.push(commit.timestamp);
      acc.commitAuthors.push(commit.author);
      acc.commitIsFix?.push(isBugFix);
      if (isBugFix) acc.bugFixCount++;
      for (const tid of taskIds) acc.taskIds.add(tid);
      if (commit.timestamp > acc.lastModifiedAt) {
        acc.lastModifiedAt = commit.timestamp;
      }
    }

    // Apply offsets for the next (older) commit
    adjustedRanges = applyOffsets(adjustedRanges, hunks);
  }
}

export async function walkCommits(opts: WalkCommitsOptions): Promise<WalkCommitsResult> {
  const { relativeChunkMap, accumulators, maxAgeMonths } = opts;
  // `opts.isoGitCache` is intentionally NOT used: all git object reads go
  // through the adapter's CLI `git cat-file`, which streams a single object
  // from the pack rather than loading the whole packfile into a JS ArrayBuffer
  // (the isomorphic-git OOM). Parent oids come straight from
  // `CommitInfo.parents` — no per-commit `git rev-parse` spawn remains
  // (bd tea-rags-mcp-iqpuu). The field remains on the options for caller
  // compatibility until the cache threading is dropped.

  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);
  const filePaths = Array.from(relativeChunkMap.keys());

  // Debug timing
  const t0 = Date.now();
  const discovery = await discoverCommits(opts, filePaths, sinceDate, t0);

  // Shared origin for the Phase-1 timing log below (discoverCommits logged its
  // own elapsed against t0).
  const t1 = Date.now();
  const collected = await collectHunksPerFile(opts, discovery);

  await Promise.all(
    Array.from(collected.fileHunkMap.entries()).map(async ([filePath, hunkDataList]) => {
      applyFileHunksToAccumulators(filePath, hunkDataList, relativeChunkMap, accumulators);
    }),
  );

  if (isDebug()) {
    console.error(
      `[ChunkChurn] Hunk mapping: ${collected.patchCalls} patches, ${collected.blobReads} blob reads, ${collected.memoHits} memo hits in ${Date.now() - t1}ms` +
        ` (skipped: ${collected.skippedEmptyBlobs} empty blobs)`,
    );
  }

  return {
    commitCount: discovery.commitEntries.length,
    holdCount: collected.holdCount,
    semWaitMs: collected.semWaitMs,
    blobReads: collected.blobReads,
    patchCalls: collected.patchCalls,
    memoHits: collected.memoHits,
  };
}
