/**
 * GitLogReader — reads git history via CLI `git log` (primary)
 * with isomorphic-git fallback.
 *
 * Builds per-file FileChurnData from git log in a single pass.
 * Falls back to isomorphic-git if CLI git log fails or times out.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

import { structuredPatch } from "diff";
import git from "isomorphic-git";

import {
  buildViaCli,
  buildViaIsomorphicGit,
  diffTrees,
  getHead,
  readBlobAsString,
  withTimeout,
} from "../../../adapters/git/client.js";
import { parseNumstatOutput, parsePathspecOutput } from "../../../adapters/git/parsers.js";
import type { ChunkLookupEntry } from "../../../types.js";
import {
  computeChunkOverlay,
  computeFileMetadata,
  isBugFixCommit,
  overlaps,
  type ChunkAccumulator,
} from "../enrichment/git/metrics.js";
import { extractTaskIds } from "../enrichment/utils.js";
import type { ChunkChurnOverlay, CommitInfo, FileChurnData } from "./types.js";

const execFileAsync = promisify(execFile);

const MAX_FILE_LINES_DEFAULT = 10000;

// Re-exports from canonical locations (backward compat for consumers)
export { type ChunkAccumulator, computeChunkOverlay, computeFileMetadata, extractTaskIds, overlaps };

export class GitLogReader {
  // isomorphic-git pack file cache (shared across calls for performance)
  private readonly cache: Record<string, unknown> = {};

  // HEAD-based result caches — invalidated when HEAD changes
  private readonly fileMetadataCache = new Map<string, { headSha: string; data: Map<string, FileChurnData> }>();
  private readonly chunkChurnCache = new Map<
    string,
    { headSha: string; data: Map<string, Map<string, ChunkChurnOverlay>> }
  >();

  /**
   * Build per-file FileChurnData from git history.
   * Primary: CLI `git log HEAD --numstat` (single process spawn).
   *
   * Falls back to isomorphic-git if CLI fails or times out.
   *
   * @param maxAgeMonths - limit commits to last N months (default: GIT_LOG_MAX_AGE_MONTHS env, default 12).
   *   Set to 0 to disable (read all commits).
   */
  async buildFileMetadataMap(repoRoot: string, maxAgeMonths?: number): Promise<Map<string, FileChurnData>> {
    const effectiveMaxAge = maxAgeMonths ?? parseFloat(process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12");

    // Cache key includes maxAge to avoid returning stale results for different time windows
    const cacheKey = `${repoRoot}:${effectiveMaxAge}`;

    // Check HEAD-based cache (non-fatal if HEAD resolution fails)
    let headSha: string | null = null;
    try {
      headSha = await getHead(repoRoot);
      const cached = this.fileMetadataCache.get(cacheKey);
      if (cached?.headSha === headSha) {
        return cached.data;
      }
    } catch {
      // Not a git repo or HEAD unresolvable — skip caching, proceed to build
    }

    const sinceDate = effectiveMaxAge > 0 ? new Date(Date.now() - effectiveMaxAge * 30 * 86400 * 1000) : undefined;

    const timeoutMs = parseInt(process.env.GIT_LOG_TIMEOUT_MS ?? "60000", 10);

    let result: Map<string, FileChurnData>;
    try {
      result = await withTimeout(buildViaCli(repoRoot, sinceDate), timeoutMs, "CLI git log timed out");
    } catch (error) {
      console.error(
        `[GitLogReader] CLI failed, falling back to isomorphic-git:`,
        error instanceof Error ? error.message : error,
      );
      result = await buildViaIsomorphicGit(repoRoot, this.cache, sinceDate);
    }

    // Store in cache if we got a valid HEAD
    if (headSha) {
      this.fileMetadataCache.set(cacheKey, { headSha, data: result });
    }
    return result;
  }

  /** @deprecated Use getHead from adapters/git/client.js */
  async getHead(repoRoot: string): Promise<string> {
    return getHead(repoRoot);
  }

  /**
   * Fetch file-level metadata for specific files (no --since filter).
   * Used as a backfill for files that weren't in the main git log window.
   * Batches file paths to stay within OS ARG_MAX limits.
   */
  async buildFileMetadataForPaths(
    repoRoot: string,
    paths: string[],
    timeoutMs = 30000,
  ): Promise<Map<string, FileChurnData>> {
    if (paths.length === 0) return new Map();

    const result = new Map<string, FileChurnData>();
    const BATCH = 500; // stay within ARG_MAX

    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH);
      const args = ["log", "HEAD", "--numstat", "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00", "--", ...batch];

      try {
        const batchResult = await withTimeout(
          execFileAsync("git", args, { cwd: repoRoot, maxBuffer: Infinity }).then(({ stdout }) =>
            parseNumstatOutput(stdout),
          ),
          timeoutMs,
          "git log backfill timed out",
        );
        for (const [path, data] of batchResult) {
          result.set(path, data);
        }
      } catch (error) {
        if (process.env.DEBUG) {
          console.error(`[GitLogReader] Backfill batch failed:`, error instanceof Error ? error.message : error);
        }
      }
    }

    return result;
  }

  /**
   * Build chunk-level churn overlays by diffing commit trees and mapping hunks to chunk line ranges.
   *
   * Algorithm:
   * 1. Walk commits within `maxAgeMonths` window via isomorphic-git
   * 2. For each commit with a parent: diffTrees → changed files
   * 3. Filter to files in chunkMap that have >1 chunk
   * 4. readBlob(parent) + readBlob(commit) → structuredPatch → hunks
   * 5. Map each hunk to overlapping chunks and accumulate per-chunk stats
   *
   * @returns Map<relativePath, Map<chunkId, ChunkChurnOverlay>>
   */
  async buildChunkChurnMap(
    repoRoot: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    concurrency = 10,
    maxAgeMonths = 6,
    fileChurnDataMap?: Map<string, FileChurnData>,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    // Check HEAD-based cache
    try {
      const headSha = await this.getHead(repoRoot);
      const cached = this.chunkChurnCache.get(repoRoot);
      if (cached?.headSha === headSha) {
        return cached.data;
      }
    } catch {
      // If HEAD resolution fails, skip caching and proceed
    }

    const result = await this._buildChunkChurnMapUncached(
      repoRoot,
      chunkMap,
      concurrency,
      maxAgeMonths,
      fileChurnDataMap,
    );

    // Store in cache
    try {
      const headSha = await this.getHead(repoRoot);
      this.chunkChurnCache.set(repoRoot, { headSha, data: result });
    } catch {
      // Non-fatal
    }

    return result;
  }

  /**
   * Get commits touching specific files via CLI pathspec filtering.
   * Much faster than reading all commits then filtering — git does the filtering.
   *
   * @returns Array of { commit, changedFiles } for commits that touch at least one path.
   */
  /**
   * Batch size for pathspec CLI calls.
   * Keeps each `git log -- file1...fileN` well under OS ARG_MAX (~1MB on macOS).
   * 500 paths × ~80 chars avg ≈ 40KB, safely below the limit.
   */
  private static readonly PATHSPEC_BATCH_SIZE = 500;

  private async getCommitsByPathspec(
    repoRoot: string,
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
    if (filePaths.length === 0) return [];

    // Batch large file lists to avoid exceeding OS ARG_MAX
    if (filePaths.length > GitLogReader.PATHSPEC_BATCH_SIZE) {
      return this.getCommitsByPathspecBatched(repoRoot, sinceDate, filePaths, timeoutMs);
    }

    return this.getCommitsByPathspecSingle(repoRoot, sinceDate, filePaths, timeoutMs);
  }

  private async getCommitsByPathspecSingle(
    repoRoot: string,
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
    const effectiveTimeoutMs = timeoutMs ?? parseInt(process.env.GIT_LOG_TIMEOUT_MS ?? "30000", 10);
    const args = [
      "log",
      `--since=${sinceDate.toISOString()}`,
      "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00",
      "--numstat",
      "--",
      ...filePaths,
    ];

    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: Infinity,
      timeout: effectiveTimeoutMs,
    });

    return parsePathspecOutput(stdout);
  }

  /**
   * Run multiple pathspec CLI calls in batches, merge results by commit SHA.
   * Same commit may appear in multiple batches (touched files in different batches).
   */
  private async getCommitsByPathspecBatched(
    repoRoot: string,
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
    const batchSize = GitLogReader.PATHSPEC_BATCH_SIZE;
    const batches: string[][] = [];
    for (let i = 0; i < filePaths.length; i += batchSize) {
      batches.push(filePaths.slice(i, i + batchSize));
    }

    const debug = process.env.DEBUG === "true" || process.env.DEBUG === "1";
    if (debug) {
      console.error(
        `[ChunkChurn] Pathspec batching: ${filePaths.length} files → ${batches.length} batches of ≤${batchSize}`,
      );
    }

    // Run batches sequentially to avoid overloading git
    const merged = new Map<string, { commit: CommitInfo; changedFiles: Set<string> }>();

    for (const batch of batches) {
      try {
        const batchResult = await this.getCommitsByPathspecSingle(repoRoot, sinceDate, batch, timeoutMs);
        for (const entry of batchResult) {
          const existing = merged.get(entry.commit.sha);
          if (existing) {
            for (const f of entry.changedFiles) existing.changedFiles.add(f);
          } else {
            merged.set(entry.commit.sha, {
              commit: entry.commit,
              changedFiles: new Set(entry.changedFiles),
            });
          }
        }
      } catch (error) {
        if (debug) {
          console.error(
            `[ChunkChurn] Pathspec batch failed (${batch.length} files):`,
            error instanceof Error ? error.message : error,
          );
        }
        // Continue with other batches — partial results are better than none
      }
    }

    return Array.from(merged.values()).map(({ commit, changedFiles }) => ({
      commit,
      changedFiles: Array.from(changedFiles),
    }));
  }

  private async _buildChunkChurnMapUncached(
    repoRoot: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
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
    let usedCli = true;
    try {
      const chunkTimeoutMs = parseInt(process.env.GIT_CHUNK_TIMEOUT_MS ?? "120000", 10);
      commitEntries = await this.getCommitsByPathspec(repoRoot, sinceDate, filePaths, chunkTimeoutMs);
    } catch (error) {
      // Fallback: isomorphic-git full log + diffTrees
      usedCli = false;
      if (debug) {
        console.error(
          `[ChunkChurn] CLI pathspec failed, falling back to isomorphic-git:`,
          error instanceof Error ? error.message : error,
        );
      }
      commitEntries = await this._getCommitsViaIsomorphicGit(repoRoot, sinceDate, relativeChunkMap);
    }

    const t1 = Date.now();

    if (debug) {
      console.error(
        `[ChunkChurn] ${usedCli ? "CLI pathspec" : "isomorphic-git fallback"}: ` +
          `${commitEntries.length} commits for ${filePaths.length} files in ${t1 - t0}ms`,
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

        // For hunk mapping, we need parent SHA. CLI doesn't give us parent directly,
        // so we use `commit.sha~1` syntax via isomorphic-git readBlob.
        // We need to resolve parent OID for blob reads.
        let parentOid: string;
        try {
          const commitObj = await git.readCommit({ fs, dir: repoRoot, oid: commit.sha, cache: this.cache });
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
              readBlobAsString(repoRoot, parentOid, filePath, this.cache),
              readBlobAsString(repoRoot, commit.sha, filePath, this.cache),
            ]);
            blobReads += 2;

            if (!oldContent && !newContent) {
              skippedEmptyBlobs++;
              return;
            }

            let hunks: { newStart: number; newLines: number }[];
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
                if (ranges.some((r) => overlaps(hunkStart, hunkEnd, r.start, r.end))) {
                  affectedChunkIds.add(e.chunkId);
                }
              }
            }

            for (const chunkId of affectedChunkIds) {
              const acc = accumulators.get(chunkId);
              if (!acc) continue;
              acc.commitShas.add(commit.sha);
              acc.authors.add(commit.author);
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
      // Use file-level commit count from buildFileMetadataMap when available.
      // This fixes chunkChurnRatio always being ~1.0 (the old denominator was
      // recomputed as the union of chunk SHAs, which ≈ max(chunkCommitCount)
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
        overlayMap.set(entry.chunkId, computeChunkOverlay(acc, fileCommitCount, fileContributorCount));
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

  /**
   * Fallback: get commits via isomorphic-git when CLI pathspec fails.
   * Reads all commits then filters via diffTrees (slower but more portable).
   */
  private async _getCommitsViaIsomorphicGit(
    repoRoot: string,
    sinceDate: Date,
    relativeChunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<{ commit: CommitInfo; changedFiles: string[] }[]> {
    const result: { commit: CommitInfo; changedFiles: string[] }[] = [];

    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({
        fs,
        dir: repoRoot,
        ref: "HEAD",
        since: sinceDate,
        cache: this.cache,
      });
    } catch {
      return result;
    }

    for (const commit of commits) {
      const parentOids = commit.commit.parent;
      if (parentOids.length === 0) continue;

      let changedFiles: string[];
      try {
        changedFiles = await diffTrees(repoRoot, parentOids[0], commit.oid, this.cache);
      } catch {
        continue;
      }

      const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
      if (relevantFiles.length === 0) continue;

      result.push({
        commit: {
          sha: commit.oid,
          author: commit.commit.author.name,
          authorEmail: commit.commit.author.email,
          timestamp: commit.commit.author.timestamp,
          body: commit.commit.message,
        },
        changedFiles: relevantFiles,
      });
    }

    return result;
  }
}
