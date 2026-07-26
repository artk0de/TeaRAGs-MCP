/**
 * Phase 2 of buildChunkChurnMapUncached: commit iteration loop.
 *
 * Fetches commits via CLI pathspec, performs parallel blob reads +
 * structuredPatch to extract hunks, then per-file sequentially maps hunks to
 * chunks with offset tracking — mutating the per-chunk accumulators in place.
 */

import { structuredPatch } from "diff";

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { BlobBatchReader, CommitInfo, FileChurnData } from "../../../../adapters/vcs/types.js";
import { isDebug } from "../../../../infra/runtime.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { buildBugFixShaSet } from "./merge-branch-resolver.js";
import { isBugFixCommitOrBranch, type ChunkAccumulator, type SquashOptions } from "./metrics.js";
import { applyOffsets, mapHunksToChunks, type AdjustedRange } from "./offset-tracker.js";
import { extractTaskIds } from "./utils.js";

/** Duck type for injected concurrency limiter — matches infra/semaphore.ts Semaphore shape. */
export interface ChunkConcurrencySemaphore {
  acquire: () => Promise<() => void>;
}

/** Structural hunk shape shared with the diff memo (positions of one structuredPatch hunk). */
export interface WalkCommitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * Duck type for the run-scoped (commitSha, filePath) → hunks memo — matches
 * infra/commit-diff-memo.ts CommitDiffMemo (bd tea-rags-mcp-7gnre). An empty
 * array is a valid memoized value (root commit / identical or empty blobs /
 * patch failure); `undefined` means never computed.
 */
export interface WalkCommitDiffMemo {
  get: (commitSha: string, filePath: string) => WalkCommitDiffHunk[] | undefined;
  set: (commitSha: string, filePath: string, hunks: WalkCommitDiffHunk[]) => void;
}

/**
 * Duck type for the run-scoped commit-discovery matrix — matches infra
 * commit-discovery.ts GitCommitDiscovery (bd tea-rags-mcp-82va1).
 */
export interface WalkCommitDiscovery {
  commitsForFiles: (filePaths: string[]) => Promise<{ commit: CommitInfo; changedFiles: string[] }[]>;
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
  maxFileLines: number;
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
}

/** Commits to walk plus the bug-fix SHA set their classification needs. */
interface CommitDiscoveryResult {
  commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
  bugFixShas: Set<string>;
}

/** Phase-1 output: raw hunks per file plus the instrumentation counters. */
interface HunkCollection {
  fileHunkMap: Map<string, CommitHunkData[]>;
  blobReads: number;
  patchCalls: number;
  memoHits: number;
  skippedLargeFiles: number;
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
    let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
    try {
      commitEntries = await discovery.commitsForFiles(filePaths);
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
  let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
  try {
    commitEntries = await opts.adapter.getCommitsByPathspec(sinceDate, filePaths, opts.chunkTimeoutMs);
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
  const { adapter, relativeChunkMap, maxFileLines, diffMemo } = opts;
  const acquire = createAcquire(opts.concurrency, opts.externalSemaphore);
  const ownsReader = opts.blobReader === undefined;
  const blobReader = opts.blobReader ?? adapter.createBlobBatchReader();
  const fileHunkMap = new Map<string, CommitHunkData[]>();
  const out: HunkCollection = {
    fileHunkMap,
    blobReads: 0,
    patchCalls: 0,
    memoHits: 0,
    skippedLargeFiles: 0,
    skippedEmptyBlobs: 0,
    holdCount: 0,
    semWaitMs: 0,
  };

  /** One (commit, file) pair: memo lookup, else two blob reads + structuredPatch. */
  const collectOneFile = async (
    filePath: string,
    commit: CommitInfo,
    parentOid: string | null,
    isBugFix: boolean,
    commitTaskIds: string[],
  ): Promise<void> => {
    const entries = relativeChunkMap.get(filePath);
    if (!entries) return;

    const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
    if (maxLine > maxFileLines) {
      out.skippedLargeFiles++;
      return;
    }

    let hunks = diffMemo?.get(commit.sha, filePath);
    if (hunks === undefined) {
      if (parentOid === null) {
        // Root commit: nothing to diff — memoize the empty result so later
        // walks short-circuit on the memo too.
        diffMemo?.set(commit.sha, filePath, []);
        return;
      }

      const [oldContent, newContent] = await Promise.all([
        blobReader.read(parentOid, filePath),
        blobReader.read(commit.sha, filePath),
      ]);
      out.blobReads += 2;

      if (!oldContent && !newContent) {
        out.skippedEmptyBlobs++;
        diffMemo?.set(commit.sha, filePath, []);
        return;
      }

      try {
        const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "");
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
    let list = fileHunkMap.get(filePath);
    if (!list) {
      list = [];
      fileHunkMap.set(filePath, list);
    }
    list.push({ commit, hunks, isBugFix, taskIds: commitTaskIds });
  };

  const collectHunks = async (entry: { commit: CommitInfo; changedFiles: string[] }): Promise<void> => {
    const acquireStart = Date.now();
    const release = await acquire();
    out.semWaitMs += Date.now() - acquireStart;
    out.holdCount++;
    try {
      const { commit, changedFiles } = entry;

      const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
      if (relevantFiles.length === 0) return;

      const isBugFix = isBugFixCommitOrBranch(commit.body, commit.sha, discovery.bugFixShas);
      const commitTaskIds = extractTaskIds(commit.body);

      // First-parent oid straight from CommitInfo.parents — already parsed
      // from `%P` by the git log parsers and validated by the discovery store,
      // so no per-commit `git rev-parse <sha>^` spawn (bd tea-rags-mcp-iqpuu;
      // ~3900 spawns/run removed). Root commit (parents [] or absent — the
      // optional chain covers loose test fixtures) → null → nothing to diff.
      const parentOid = entry.commit.parents?.[0] ?? null;

      await Promise.all(
        relevantFiles.map(async (filePath) => collectOneFile(filePath, commit, parentOid, isBugFix, commitTaskIds)),
      );
    } finally {
      release();
    }
  };

  try {
    await Promise.all(discovery.commitEntries.map(collectHunks));
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

  // Sort commits newest→oldest for backward offset tracking
  hunkDataList.sort((a, b) => b.commit.timestamp - a.commit.timestamp);

  // Init adjusted ranges from HEAD chunk positions
  let adjustedRanges: AdjustedRange[] = entries.map((e) => ({
    chunkId: e.chunkId,
    start: e.startLine,
    end: e.endLine,
  }));

  for (const { commit, hunks, isBugFix, taskIds } of hunkDataList) {
    // Map hunks to chunks using current adjusted ranges
    const affectedChunkIds = mapHunksToChunks(hunks, adjustedRanges);

    // Compute relativeChurn from hunk overlaps with adjusted ranges
    for (const hunk of hunks) {
      const hunkStart = hunk.newStart;
      const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
      for (const r of adjustedRanges) {
        if (hunkStart <= r.end && hunkEnd >= r.start) {
          const acc = accumulators.get(r.chunkId);
          if (acc) {
            const overlapLines = Math.min(hunkEnd, r.end) - Math.max(hunkStart, r.start) + 1;
            acc.linesAdded += overlapLines;
            if (hunk.newLines > 0) {
              acc.linesDeleted += Math.round((hunk.oldLines * overlapLines) / hunk.newLines);
            }
          }
        }
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
        ` (skipped: ${collected.skippedLargeFiles} large files, ${collected.skippedEmptyBlobs} empty blobs)`,
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
