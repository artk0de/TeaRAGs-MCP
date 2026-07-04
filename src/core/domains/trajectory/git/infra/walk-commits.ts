/**
 * Phase 2 of buildChunkChurnMapUncached: commit iteration loop.
 *
 * Fetches commits via CLI pathspec, performs parallel blob reads +
 * structuredPatch to extract hunks, then per-file sequentially maps hunks to
 * chunks with offset tracking — mutating the per-chunk accumulators in place.
 */

import { structuredPatch } from "diff";

import {
  createCatFileBatch,
  getCommitsByPathspec,
  readCommitParent,
  type CatFileBatchReader,
} from "../../../../adapters/git/client.js";
import type { CommitInfo, FileChurnData } from "../../../../adapters/git/types.js";
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

export interface WalkCommitsResult {
  /** Number of commits returned by `getCommitsByPathspec`. */
  commitCount: number;
}

export interface WalkCommitsOptions {
  repoRoot: string;
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
  blobReader?: CatFileBatchReader;
  /**
   * Run-scoped, caller-owned (commitSha, filePath) → hunks memo shared across
   * the per-batch walks of one indexing run (bd tea-rags-mcp-7gnre). A memo
   * hit skips the parent rev lookup, both blob reads, and structuredPatch for
   * that (commit, file); a miss computes then memoizes — including empty
   * results, so known-empty diffs are never recomputed. The walk never clears
   * it — lifecycle belongs to the caller (ChunkPhase drops it at drain).
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

export async function walkCommits(opts: WalkCommitsOptions): Promise<WalkCommitsResult> {
  const {
    repoRoot,
    relativeChunkMap,
    accumulators,
    concurrency,
    maxAgeMonths,
    chunkTimeoutMs,
    maxFileLines,
    externalSemaphore,
  } = opts;
  // `opts.isoGitCache` is intentionally NOT used: all git object reads go
  // through the adapter's CLI `git cat-file` / `git rev-parse`, which stream a
  // single object from the pack rather than loading the whole packfile into a
  // JS ArrayBuffer (the isomorphic-git OOM). The field remains on the options
  // for caller compatibility until the cache threading is dropped.

  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);
  const filePaths = Array.from(relativeChunkMap.keys());

  // Debug timing
  const t0 = Date.now();

  let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
  let bugFixShas: Set<string>;
  if (opts.commitDiscovery) {
    // bd tea-rags-mcp-82va1: slice the ONE run-scoped matrix in-memory instead
    // of paying a per-batch pathspec log; the bugFixShaSet is the ONE shared
    // set over ALL matrix commits. Same failure semantics as the legacy
    // branch: a broken discovery ⇒ no churn for this batch.
    const discovery = opts.commitDiscovery;
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
    bugFixShas = await discovery.getBugFixShas().catch(() => new Set<string>());

    const sliceEnd = Date.now();
    if (isDebug()) {
      console.error(
        `[ChunkChurn] discovery slice: ${commitEntries.length} commits for ${filePaths.length} files in ${sliceEnd - t0}ms`,
      );
    }
  } else {
    // Use CLI pathspec filtering — only fetches commits touching our files
    try {
      commitEntries = await getCommitsByPathspec(repoRoot, sinceDate, filePaths, chunkTimeoutMs);
    } catch (error) {
      // CLI pathspec failed — no fallback (isomorphic-git git.log causes OOM on large repos)
      if (isDebug()) {
        console.error(
          `[ChunkChurn] CLI pathspec failed, skipping chunk churn:`,
          error instanceof Error ? error.message : error,
        );
      }
      commitEntries = [];
    }

    const pathspecEnd = Date.now();

    if (isDebug()) {
      console.error(
        `[ChunkChurn] CLI pathspec: ${commitEntries.length} commits for ${filePaths.length} files in ${pathspecEnd - t0}ms`,
      );
    }

    // Build bug-fix SHA set from merge branch prefixes
    bugFixShas = buildBugFixShaSet(commitEntries.map((e) => e.commit));
  }

  // Shared origin for the Phase-1 timing log below (either branch above logged
  // its own discovery elapsed against t0).
  const t1 = Date.now();

  // ─── Phase 1: Parallel blob reads + structuredPatch → raw hunk data ───
  let blobReads = 0;
  let patchCalls = 0;
  let skippedLargeFiles = 0;
  let skippedEmptyBlobs = 0;

  interface CommitHunkData {
    commit: CommitInfo;
    hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[];
    isBugFix: boolean;
    taskIds: string[];
  }

  const fileHunkMap = new Map<string, CommitHunkData[]>();

  // Bounded concurrency: external semaphore (coordinator-shared) or internal.
  // Unified shape: acquire() returns a per-call release closure.
  const acquire: () => Promise<() => void> = externalSemaphore
    ? async () => externalSemaphore.acquire()
    : (() => {
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
      })();

  // One persistent `git cat-file --batch` process for the whole walk. The
  // chunk-churn does tens of thousands of blob reads; the earlier per-call
  // `git cat-file blob` spawned a git process EACH time (fork + reopen the
  // pack .idx) and dominated wall time. Reused across all collectHunks reads,
  // closed in the finally below. See `.claude/rules/git-cat-file-batch.md`.
  //
  // kc93: a run-scoped reader may be INJECTED by the caller (ChunkPhase) so the
  // SAME process is shared across every per-batch walk of a run — the pack is
  // opened once for the whole run, not once per batch. When injected, the
  // caller owns the lifecycle and we must NOT close it here; only a reader we
  // spawned ourselves is closed in the `finally`.
  const ownsReader = opts.blobReader === undefined;
  const blobReader = opts.blobReader ?? createCatFileBatch(repoRoot);

  const { diffMemo } = opts;
  let memoHits = 0;

  const collectHunks = async (entry: { commit: CommitInfo; changedFiles: string[] }): Promise<void> => {
    const release = await acquire();
    try {
      const { commit, changedFiles } = entry;

      const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
      if (relevantFiles.length === 0) return;

      const isBugFix = isBugFixCommitOrBranch(commit.body, commit.sha, bugFixShas);
      const commitTaskIds = extractTaskIds(commit.body);

      // First-parent oid via the git adapter (CLI). Root commit → null → no
      // parent to diff against. The adapter owns the git mechanics; no
      // isomorphic-git here (it loaded the whole packfile into memory).
      // 7gnre: resolved LAZILY — once per commit, and ONLY when at least one
      // file misses the diff memo — so a fully-memoized commit costs zero git
      // calls on later walks of the same run.
      let parentOidPromise: Promise<string | null> | undefined;
      const getParentOid = async (): Promise<string | null> =>
        (parentOidPromise ??= readCommitParent(repoRoot, commit.sha));

      await Promise.all(
        relevantFiles.map(async (filePath) => {
          const entries = relativeChunkMap.get(filePath);
          if (!entries) return;

          const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
          if (maxLine > maxFileLines) {
            skippedLargeFiles++;
            return;
          }

          let hunks = diffMemo?.get(commit.sha, filePath);
          if (hunks === undefined) {
            const parentOid = await getParentOid();
            if (parentOid === null) {
              // Root commit: nothing to diff — memoize the empty result so
              // later walks skip the rev lookup retry too.
              diffMemo?.set(commit.sha, filePath, []);
              return;
            }

            const [oldContent, newContent] = await Promise.all([
              blobReader.read(parentOid, filePath),
              blobReader.read(commit.sha, filePath),
            ]);
            blobReads += 2;

            if (!oldContent && !newContent) {
              skippedEmptyBlobs++;
              diffMemo?.set(commit.sha, filePath, []);
              return;
            }

            try {
              const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "");
              ({ hunks } = patch);
              patchCalls++;
            } catch {
              // Deterministic for identical content — memoize the failure as
              // empty so later walks don't re-read + re-throw.
              diffMemo?.set(commit.sha, filePath, []);
              return;
            }
            diffMemo?.set(commit.sha, filePath, hunks);
          } else {
            memoHits++;
          }

          if (hunks.length === 0) return;

          // Collect into fileHunkMap (safe: JS single-threaded between awaits)
          let list = fileHunkMap.get(filePath);
          if (!list) {
            list = [];
            fileHunkMap.set(filePath, list);
          }
          list.push({ commit, hunks, isBugFix, taskIds: commitTaskIds });
        }),
      );
    } finally {
      release();
    }
  };

  try {
    await Promise.all(commitEntries.map(collectHunks));
  } finally {
    // Tear the cat-file process down once all blob reads are done (Phase 2 maps
    // hunks → chunks in-memory, no further git reads) — but ONLY if we spawned
    // it. A caller-injected (run-scoped) reader is closed by the caller.
    if (ownsReader) await blobReader.close();
  }

  // ─── Phase 2: Sequential per file, parallel across files — offset-aware mapping ───
  const processFileHunks = async (filePath: string, hunkDataList: CommitHunkData[]): Promise<void> => {
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
  };

  await Promise.all(
    Array.from(fileHunkMap.entries()).map(async ([filePath, hunkDataList]) => processFileHunks(filePath, hunkDataList)),
  );

  const t2 = Date.now();

  if (isDebug()) {
    console.error(
      `[ChunkChurn] Hunk mapping: ${patchCalls} patches, ${blobReads} blob reads, ${memoHits} memo hits in ${t2 - t1}ms` +
        ` (skipped: ${skippedLargeFiles} large files, ${skippedEmptyBlobs} empty blobs)`,
    );
  }

  return { commitCount: commitEntries.length };
}
