/**
 * Chunk-level churn analysis from git history.
 * Uses CLI for commit discovery, isomorphic-git only for individual object reads
 * (readCommit for parent OID, readBlob for file content).
 */

import * as fs from "node:fs";

import { structuredPatch } from "diff";
import git from "isomorphic-git";

import { getCommitsByPathspec, readBlobAsString } from "../../../adapters/git/client.js";
import type { CommitInfo, FileChurnData } from "../../../adapters/git/types.js";
import type { ChunkLookupEntry } from "../../../types.js";
import type { ChunkChurnOverlay } from "../types.js";
import type { GitEnrichmentCache } from "./cache.js";
import { computeChunkSignals, isBugFixCommit, overlaps, type ChunkAccumulator } from "./metrics.js";

const MAX_FILE_LINES_DEFAULT = 10000;

/**
 * Build chunk-level churn overlays by mapping git hunks to chunk line ranges.
 *
 * Algorithm:
 * 1. Get commits within `maxAgeMonths` window via CLI pathspec filtering
 * 2. For each commit: readCommit → parent OID, readBlob × 2 → structuredPatch → hunks
 * 3. Map each hunk to overlapping chunks and accumulate per-chunk stats
 *
 * @returns Map<relativePath, Map<chunkId, ChunkChurnOverlay>>
 */
export async function buildChunkChurnMap(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  enrichmentCache: GitEnrichmentCache,
  isoGitCache: Record<string, unknown>,
  concurrency = 10,
  maxAgeMonths = 6,
  fileChurnDataMap?: Map<string, FileChurnData>,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  // Check HEAD-based cache
  const cached = await enrichmentCache.getChunkChurn(repoRoot);
  if (cached) return cached;

  const result = await buildChunkChurnMapUncached(
    repoRoot,
    chunkMap,
    isoGitCache,
    concurrency,
    maxAgeMonths,
    fileChurnDataMap,
  );

  // Store in cache (non-fatal if HEAD unresolvable)
  await enrichmentCache.setChunkChurn(repoRoot, result);

  return result;
}

export async function buildChunkChurnMapUncached(
  repoRoot: string,
  chunkMap: Map<string, ChunkLookupEntry[]>,
  isoGitCache: Record<string, unknown>,
  concurrency: number,
  maxAgeMonths: number,
  fileChurnDataMap?: Map<string, FileChurnData>,
): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
  const maxFileLines = parseInt(process.env.GIT_CHUNK_MAX_FILE_LINES ?? String(MAX_FILE_LINES_DEFAULT), 10);

  // Build relative path → entries lookup (chunkMap keys may be absolute paths)
  // Also filter: only files with >1 chunk benefit from chunk-level analysis
  const relativeChunkMap = new Map<string, ChunkLookupEntry[]>();
  for (const [filePath, entries] of chunkMap) {
    if (entries.length <= 1) continue; // skip single-chunk files
    const relPath = filePath.startsWith(repoRoot) ? filePath.slice(repoRoot.length + 1) : filePath;
    relativeChunkMap.set(relPath, entries);
  }

  if (relativeChunkMap.size === 0) {
    return new Map();
  }

  // Per-chunk accumulators
  const accumulators = new Map<string, ChunkAccumulator>();

  for (const [, entries] of relativeChunkMap) {
    for (const entry of entries) {
      accumulators.set(entry.chunkId, {
        commitShas: new Set(),
        authors: new Set(),
        bugFixCount: 0,
        lastModifiedAt: 0,
        linesAdded: 0,
        linesDeleted: 0,
        commitTimestamps: [],
      });
    }
  }

  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  const sinceDate = new Date(Date.now() - effectiveMonths * 30 * 86400 * 1000);
  const filePaths = Array.from(relativeChunkMap.keys());

  // Debug timing
  const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
  const t0 = Date.now();

  // Use CLI pathspec filtering — only fetches commits touching our files
  let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
  try {
    const chunkTimeoutMs = parseInt(process.env.GIT_CHUNK_TIMEOUT_MS ?? "120000", 10);
    commitEntries = await getCommitsByPathspec(repoRoot, sinceDate, filePaths, chunkTimeoutMs);
  } catch (error) {
    // CLI pathspec failed — no fallback (isomorphic-git git.log causes OOM on large repos)
    if (debug) {
      console.error(
        `[ChunkChurn] CLI pathspec failed, skipping chunk churn:`,
        error instanceof Error ? error.message : error,
      );
    }
    commitEntries = [];
  }

  const t1 = Date.now();

  if (debug) {
    console.error(
      `[ChunkChurn] CLI pathspec: ${commitEntries.length} commits for ${filePaths.length} files in ${t1 - t0}ms`,
    );
  }

  // Process commits: for each, read blobs and compute hunk→chunk mapping
  let blobReads = 0;
  let patchCalls = 0;
  let skippedLargeFiles = 0;
  let skippedEmptyBlobs = 0;

  // Process commits with bounded concurrency
  let activeCount = 0;
  const queue: (() => void)[] = [];
  const acquire = async (): Promise<void> => {
    if (activeCount < concurrency) {
      activeCount++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => queue.push(resolve));
  };
  const release = (): void => {
    const next = queue.shift();
    if (next) {
      next();
    } else {
      activeCount--;
    }
  };

  const processCommitEntry = async (entry: { commit: CommitInfo; changedFiles: string[] }): Promise<void> => {
    await acquire();
    try {
      const { commit, changedFiles } = entry;

      // Filter to files we care about (CLI already filtered, but double-check)
      const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
      if (relevantFiles.length === 0) return;

      const isBugFix = isBugFixCommit(commit.body);

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

          const affectedChunkIds = new Set<string>();
          for (const hunk of hunks) {
            const hunkStart = hunk.newStart;
            const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
            for (const e of entries) {
              const ranges = e.lineRanges || [{ start: e.startLine, end: e.endLine }];
              for (const r of ranges) {
                if (overlaps(hunkStart, hunkEnd, r.start, r.end)) {
                  affectedChunkIds.add(e.chunkId);
                  // Track hunk overlap for relativeChurn
                  const acc = accumulators.get(e.chunkId);
                  if (acc) {
                    const overlapLines = Math.min(hunkEnd, r.end) - Math.max(hunkStart, r.start) + 1;
                    acc.linesAdded += overlapLines;
                    if (hunk.newLines > 0) {
                      acc.linesDeleted += Math.round((hunk.oldLines * overlapLines) / hunk.newLines);
                    }
                  }
                  break;
                }
              }
            }
          }

          for (const chunkId of affectedChunkIds) {
            const acc = accumulators.get(chunkId);
            if (!acc) continue;
            acc.commitShas.add(commit.sha);
            acc.authors.add(commit.author);
            acc.commitTimestamps.push(commit.timestamp);
            if (isBugFix) acc.bugFixCount++;
            if (commit.timestamp > acc.lastModifiedAt) {
              acc.lastModifiedAt = commit.timestamp;
            }
          }
        }),
      );
    } finally {
      release();
    }
  };

  await Promise.all(commitEntries.map(processCommitEntry));

  const t2 = Date.now();

  if (debug) {
    console.error(
      `[ChunkChurn] Hunk mapping: ${patchCalls} patches, ${blobReads} blob reads in ${t2 - t1}ms` +
        ` (skipped: ${skippedLargeFiles} large files, ${skippedEmptyBlobs} empty blobs)`,
    );
  }

  // Build result map
  const result = new Map<string, Map<string, ChunkChurnOverlay>>();

  for (const [relPath, entries] of relativeChunkMap) {
    // Use file-level commit count from buildFileSignalMap when available.
    // This fixes churnRatio always being ~1.0 (the old denominator was
    // recomputed as the union of chunk SHAs, which ≈ max(commitCount)
    // for tightly-coupled files).
    const fileChurnData = fileChurnDataMap?.get(relPath);
    let fileCommitCount: number;
    let fileContributorCount: number | undefined;

    if (fileChurnData) {
      fileCommitCount = Math.max(fileChurnData.commits.length, 1);
      const uniqueAuthors = new Set(fileChurnData.commits.map((c) => c.author));
      fileContributorCount = uniqueAuthors.size;
    } else {
      // Fallback: union of chunk commit SHAs (original behavior)
      const fileCommitShas = new Set<string>();
      for (const entry of entries) {
        const acc = accumulators.get(entry.chunkId);
        if (!acc) continue;
        for (const sha of acc.commitShas) {
          fileCommitShas.add(sha);
        }
      }
      fileCommitCount = Math.max(fileCommitShas.size, 1);
    }

    const overlayMap = new Map<string, ChunkChurnOverlay>();

    for (const entry of entries) {
      const acc = accumulators.get(entry.chunkId);
      if (!acc) continue;
      const chunkLineCount = entry.endLine - entry.startLine + 1;
      overlayMap.set(entry.chunkId, computeChunkSignals(acc, fileCommitCount, fileContributorCount, chunkLineCount));
    }

    if (overlayMap.size > 0) {
      result.set(relPath, overlayMap);
    }
  }

  if (debug) {
    const totalMs = Date.now() - t0;
    const filesWithOverlays = result.size;
    const totalOverlays = Array.from(result.values()).reduce((sum, m) => sum + m.size, 0);
    console.error(
      `[ChunkChurn] Total: ${totalMs}ms | ${commitEntries.length} commits → ` +
        `${totalOverlays} overlays across ${filesWithOverlays} files`,
    );
  }

  return result;
}
