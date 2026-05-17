/**
 * Phase 2 of buildChunkChurnMapUncached: commit iteration loop.
 *
 * Fetches commits via CLI pathspec, performs parallel blob reads +
 * structuredPatch to extract hunks, then per-file sequentially maps hunks to
 * chunks with offset tracking — mutating the per-chunk accumulators in place.
 */

import * as fs from "node:fs";

import { structuredPatch } from "diff";
import git from "isomorphic-git";

import { getCommitsByPathspec, readBlobAsString } from "../../../../adapters/git/client.js";
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
}

export async function walkCommits(opts: WalkCommitsOptions): Promise<WalkCommitsResult> {
  const {
    repoRoot,
    relativeChunkMap,
    accumulators,
    isoGitCache,
    concurrency,
    maxAgeMonths,
    chunkTimeoutMs,
    maxFileLines,
    externalSemaphore,
  } = opts;

  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);
  const filePaths = Array.from(relativeChunkMap.keys());

  // Debug timing
  const t0 = Date.now();

  // Use CLI pathspec filtering — only fetches commits touching our files
  let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
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

  const t1 = Date.now();

  if (isDebug()) {
    console.error(
      `[ChunkChurn] CLI pathspec: ${commitEntries.length} commits for ${filePaths.length} files in ${t1 - t0}ms`,
    );
  }

  // Build bug-fix SHA set from merge branch prefixes
  const allCommitsForMerge = commitEntries.map((e) => e.commit);
  const bugFixShas = buildBugFixShaSet(allCommitsForMerge);

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

  const collectHunks = async (entry: { commit: CommitInfo; changedFiles: string[] }): Promise<void> => {
    const release = await acquire();
    try {
      const { commit, changedFiles } = entry;

      const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
      if (relevantFiles.length === 0) return;

      const isBugFix = isBugFixCommitOrBranch(commit.body, commit.sha, bugFixShas);
      const commitTaskIds = extractTaskIds(commit.body);

      // Resolve parent OID via isomorphic-git readCommit (single object read, not a walk)
      let parentOid: string;
      try {
        const commitObj = await git.readCommit({ fs, dir: repoRoot, oid: commit.sha, cache: isoGitCache });
        if (commitObj.commit.parent.length === 0) return; // root commit
        parentOid = commitObj.commit.parent[0];
      } catch {
        return;
      }

      await Promise.all(
        relevantFiles.map(async (filePath) => {
          const entries = relativeChunkMap.get(filePath);
          if (!entries) return;

          const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
          if (maxLine > maxFileLines) {
            skippedLargeFiles++;
            return;
          }

          const [oldContent, newContent] = await Promise.all([
            readBlobAsString(repoRoot, parentOid, filePath, isoGitCache),
            readBlobAsString(repoRoot, commit.sha, filePath, isoGitCache),
          ]);
          blobReads += 2;

          if (!oldContent && !newContent) {
            skippedEmptyBlobs++;
            return;
          }

          let hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number }[];
          try {
            const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "");
            ({ hunks } = patch);
            patchCalls++;
          } catch {
            return;
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

  await Promise.all(commitEntries.map(collectHunks));

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
      `[ChunkChurn] Hunk mapping: ${patchCalls} patches, ${blobReads} blob reads in ${t2 - t1}ms` +
        ` (skipped: ${skippedLargeFiles} large files, ${skippedEmptyBlobs} empty blobs)`,
    );
  }

  return { commitCount: commitEntries.length };
}
