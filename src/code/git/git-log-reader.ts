/**
 * GitLogReader — reads git history via CLI `git log` (primary)
 * with isomorphic-git fallback.
 *
 * Builds per-file FileChurnData from git log in a single pass.
 * Falls back to isomorphic-git if CLI git log fails or times out.
 */

import git from "isomorphic-git";
import * as fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { structuredPatch } from "diff";
import type { CommitInfo, FileChurnData, GitFileMetadata, ChunkChurnOverlay } from "./types.js";
import type { ChunkLookupEntry } from "../types.js";

const execFileAsync = promisify(execFile);

const BUG_FIX_PATTERN_CHUNK = /\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i;
const MAX_FILE_LINES_DEFAULT = 10000;

/**
 * Check if a hunk range overlaps with a chunk range.
 * Both ranges are inclusive: [start, end].
 */
export function overlaps(
  hunkStart: number,
  hunkEnd: number,
  chunkStart: number,
  chunkEnd: number,
): boolean {
  return hunkStart <= chunkEnd && hunkEnd >= chunkStart;
}

/**
 * Extract task IDs from commit message text.
 * Supports JIRA (TD-1234), GitHub (#123), Azure DevOps (AB#123), GitLab (!123).
 */
export function extractTaskIds(text: string): string[] {
  if (!text) return [];

  const taskIds = new Set<string>();

  // JIRA/Linear style: ABC-123
  const jiraPattern = /\b([A-Z]{2,10}-\d{1,6})\b/g;
  let match;
  while ((match = jiraPattern.exec(text)) !== null) {
    taskIds.add(match[1]);
  }

  // GitHub style: #123 (not preceded by &)
  const githubPattern = /(?:^|[^&])#(\d{1,7})\b/g;
  while ((match = githubPattern.exec(text)) !== null) {
    taskIds.add(`#${match[1]}`);
  }

  // Azure DevOps: AB#123
  const azurePattern = /\bAB#(\d{1,7})\b/g;
  while ((match = azurePattern.exec(text)) !== null) {
    taskIds.add(`AB#${match[1]}`);
  }

  // GitLab MR: !123
  const gitlabPattern = /!(\d{1,7})\b/g;
  while ((match = gitlabPattern.exec(text)) !== null) {
    taskIds.add(`!${match[1]}`);
  }

  return Array.from(taskIds);
}

/**
 * Compute churn metrics for a single file from its commit history.
 */
export function computeFileMetadata(
  churnData: FileChurnData,
  currentLineCount: number,
): GitFileMetadata {
  const nowSec = Date.now() / 1000;
  const commits = churnData.commits;

  if (commits.length === 0) {
    return {
      dominantAuthor: "unknown",
      dominantAuthorEmail: "",
      authors: [],
      dominantAuthorPct: 0,
      lastModifiedAt: 0,
      firstCreatedAt: 0,
      lastCommitHash: "",
      ageDays: 0,
      commitCount: 0,
      linesAdded: churnData.linesAdded,
      linesDeleted: churnData.linesDeleted,
      relativeChurn: 0,
      recencyWeightedFreq: 0,
      changeDensity: 0,
      churnVolatility: 0,
      bugFixRate: 0,
      contributorCount: 0,
      taskIds: [],
    };
  }

  // Sort commits by timestamp ascending
  const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);

  // Author aggregation (by commit count)
  const authorCounts = new Map<string, { count: number; email: string }>();
  const allTaskIds = new Set<string>();

  for (const c of commits) {
    const existing = authorCounts.get(c.author);
    if (existing) {
      existing.count++;
    } else {
      authorCounts.set(c.author, { count: 1, email: c.authorEmail });
    }
    for (const tid of extractTaskIds(c.body)) {
      allTaskIds.add(tid);
    }
  }

  // Find dominant author
  let dominantAuthor = "";
  let dominantAuthorEmail = "";
  let maxCount = 0;
  for (const [author, data] of authorCounts) {
    if (data.count > maxCount) {
      maxCount = data.count;
      dominantAuthor = author;
      dominantAuthorEmail = data.email;
    }
  }

  const lastCommit = sorted[sorted.length - 1];
  const firstCommit = sorted[0];
  const ageDays = Math.max(0, Math.floor((nowSec - lastCommit.timestamp) / 86400));

  // Relative churn
  const totalChurn = churnData.linesAdded + churnData.linesDeleted;
  const relativeChurn = totalChurn / Math.max(currentLineCount, 1);

  // Recency-weighted frequency: Σ exp(-0.1 × daysAgo)
  const recencyWeightedFreq = commits.reduce((sum, c) => {
    const daysAgo = (nowSec - c.timestamp) / 86400;
    return sum + Math.exp(-0.1 * daysAgo);
  }, 0);

  // Change density: commits / months
  const spanMonths = Math.max(
    (lastCommit.timestamp - firstCommit.timestamp) / (86400 * 30),
    1,
  );
  const changeDensity = commits.length / spanMonths;

  // Churn volatility: stddev of days between consecutive commits
  let churnVolatility = 0;
  if (sorted.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push((sorted[i].timestamp - sorted[i - 1].timestamp) / 86400);
    }
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((sum, g) => sum + (g - mean) ** 2, 0) / gaps.length;
    churnVolatility = Math.sqrt(variance);
  }

  // Bug fix rate: percentage of commits with fix/bug/hotfix/patch keywords
  const BUG_FIX_PATTERN = /\b(fix|bug|hotfix|patch|resolve[sd]?|defect)\b/i;
  const bugFixRate = Math.round(
    (commits.filter((c) => BUG_FIX_PATTERN.test(c.body)).length / commits.length) * 100,
  );
  const contributorCount = authorCounts.size;

  return {
    dominantAuthor,
    dominantAuthorEmail,
    authors: Array.from(authorCounts.keys()),
    dominantAuthorPct: Math.round((maxCount / commits.length) * 100),
    lastModifiedAt: lastCommit.timestamp,
    firstCreatedAt: firstCommit.timestamp,
    lastCommitHash: lastCommit.sha,
    ageDays,
    commitCount: commits.length,
    linesAdded: churnData.linesAdded,
    linesDeleted: churnData.linesDeleted,
    relativeChurn: Math.round(relativeChurn * 100) / 100,
    recencyWeightedFreq: Math.round(recencyWeightedFreq * 100) / 100,
    changeDensity: Math.round(changeDensity * 100) / 100,
    churnVolatility: Math.round(churnVolatility * 100) / 100,
    bugFixRate,
    contributorCount,
    taskIds: Array.from(allTaskIds),
  };
}

export class GitLogReader {
  // isomorphic-git pack file cache (shared across calls for performance)
  private cache: Record<string, any> = {};

  // HEAD-based result caches — invalidated when HEAD changes
  private fileMetadataCache = new Map<string, { headSha: string; data: Map<string, FileChurnData> }>();
  private chunkChurnCache = new Map<string, { headSha: string; data: Map<string, Map<string, ChunkChurnOverlay>> }>();

  /**
   * Build per-file FileChurnData from git history.
   * Primary: CLI `git log HEAD --numstat` (single process spawn).
   *
   * Falls back to isomorphic-git if CLI fails or times out.
   *
   * @param maxAgeMonths - limit commits to last N months (default: GIT_LOG_MAX_AGE_MONTHS env, default 12).
   *   Set to 0 to disable (read all commits).
   */
  async buildFileMetadataMap(
    repoRoot: string,
    maxAgeMonths?: number,
  ): Promise<Map<string, FileChurnData>> {
    const effectiveMaxAge = maxAgeMonths ?? parseFloat(process.env.GIT_LOG_MAX_AGE_MONTHS ?? "12");

    // Cache key includes maxAge to avoid returning stale results for different time windows
    const cacheKey = `${repoRoot}:${effectiveMaxAge}`;

    // Check HEAD-based cache (non-fatal if HEAD resolution fails)
    let headSha: string | null = null;
    try {
      headSha = await this.getHead(repoRoot);
      const cached = this.fileMetadataCache.get(cacheKey);
      if (cached && cached.headSha === headSha) {
        return cached.data;
      }
    } catch {
      // Not a git repo or HEAD unresolvable — skip caching, proceed to build
    }

    const sinceDate =
      effectiveMaxAge > 0
        ? new Date(Date.now() - effectiveMaxAge * 30 * 86400 * 1000)
        : undefined;

    const timeoutMs = parseInt(process.env.GIT_LOG_TIMEOUT_MS ?? "60000", 10);

    let result: Map<string, FileChurnData>;
    try {
      result = await this.withTimeout(
        this.buildViaCli(repoRoot, sinceDate),
        timeoutMs,
        "CLI git log timed out",
      );
    } catch (error) {
      console.error(
        `[GitLogReader] CLI failed, falling back to isomorphic-git:`,
        error instanceof Error ? error.message : error,
      );
      result = await this.buildViaIsomorphicGit(repoRoot, sinceDate);
    }

    // Store in cache if we got a valid HEAD
    if (headSha) {
      this.fileMetadataCache.set(cacheKey, { headSha, data: result });
    }
    return result;
  }

  /**
   * Race a promise against a timeout. Rejects with Error(message) on expiry.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }

  /** HEAD SHA */
  async getHead(repoRoot: string): Promise<string> {
    try {
      return await git.resolveRef({ fs, dir: repoRoot, ref: "HEAD" });
    } catch {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
      return stdout.trim();
    }
  }


  /**
   * Build the CLI args array for `git log`.
   * Uses HEAD (not --all) and no --max-count.
   */
  private buildCliArgs(sinceDate?: Date): string[] {
    const args = [
      "log",
      "HEAD",
      "--numstat",
      "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00",
    ];
    if (sinceDate) {
      args.push(`--since=${sinceDate.toISOString()}`);
    }
    return args;
  }

  /**
   * Primary path: isomorphic-git reads .git directly.
   *
   * Algorithm:
   * 1. Walk all commits via git.log
   * 2. For each pair of consecutive commits, diff the trees
   * 3. Build per-file commit list and numstat via TREE walk
   */
  private async buildViaIsomorphicGit(
    repoRoot: string,
    sinceDate?: Date,
  ): Promise<Map<string, FileChurnData>> {
    const fileMap = new Map<string, FileChurnData>();

    // Get commits (ordered newest-first), bounded by since date
    const commits = await git.log({
      fs,
      dir: repoRoot,
      ref: "HEAD",
      since: sinceDate,
      cache: this.cache,
    });

    if (commits.length === 0) return fileMap;

    // Process commits oldest-first so we can build up the file map chronologically
    // For each commit, diff its tree against parent to find changed files
    for (let i = commits.length - 1; i >= 0; i--) {
      const commit = commits[i];
      const commitInfo: CommitInfo = {
        sha: commit.oid,
        author: commit.commit.author.name,
        authorEmail: commit.commit.author.email,
        timestamp: commit.commit.author.timestamp,
        body: commit.commit.message,
      };

      const parentOids = commit.commit.parent;

      // Get changed files by diffing trees
      let changedFiles: string[];
      try {
        if (parentOids.length === 0) {
          // Root commit — all files in this tree are "added"
          changedFiles = await this.listAllFiles(repoRoot, commit.oid);
        } else {
          // Diff against first parent
          changedFiles = await this.diffTrees(repoRoot, parentOids[0], commit.oid);
        }
      } catch {
        // If tree diff fails for this commit, skip it
        continue;
      }

      for (const filePath of changedFiles) {
        let entry = fileMap.get(filePath);
        if (!entry) {
          entry = { commits: [], linesAdded: 0, linesDeleted: 0 };
          fileMap.set(filePath, entry);
        }
        entry.commits.push(commitInfo);
      }
    }

    // isomorphic-git doesn't support --numstat natively,
    // so we collect line stats via a single CLI call (fast — one process only)
    await this.enrichLineStats(repoRoot, fileMap, sinceDate);

    return fileMap;
  }

  /**
   * List all files in a commit's tree (for root commits with no parent)
   */
  private async listAllFiles(repoRoot: string, commitOid: string): Promise<string[]> {
    const files: string[] = [];

    await git.walk({
      fs,
      dir: repoRoot,
      trees: [git.TREE({ ref: commitOid })],
      cache: this.cache,
      map: async (filepath, entries) => {
        if (!entries || !entries[0]) return;
        const entry = entries[0];
        const type = await entry.type();
        if (type === "blob" && filepath !== ".") {
          files.push(filepath);
        }
      },
    });

    return files;
  }

  /**
   * Diff two commit trees to find changed files
   */
  private async diffTrees(repoRoot: string, parentOid: string, commitOid: string): Promise<string[]> {
    const changedFiles: string[] = [];

    await git.walk({
      fs,
      dir: repoRoot,
      trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: commitOid })],
      cache: this.cache,
      map: async (filepath, entries) => {
        if (!entries || filepath === ".") return;
        const [parentEntry, commitEntry] = entries;

        // Get OIDs — changed if different
        const parentOidFile = parentEntry ? await parentEntry.oid() : undefined;
        const commitOidFile = commitEntry ? await commitEntry.oid() : undefined;

        if (parentOidFile !== commitOidFile) {
          // Only include blobs, not trees
          const type = commitEntry
            ? await commitEntry.type()
            : parentEntry
              ? await parentEntry.type()
              : undefined;
          if (type === "blob") {
            changedFiles.push(filepath);
          }
        }
      },
    });

    return changedFiles;
  }

  /**
   * Enrich fileMap with line stats from a single CLI git log call.
   * This is the only process spawn — one call for the entire repo.
   */
  private async enrichLineStats(
    repoRoot: string,
    fileMap: Map<string, FileChurnData>,
    sinceDate?: Date,
  ): Promise<void> {
    try {
      const args = ["log", "HEAD", "--numstat", "--format="];
      if (sinceDate) {
        args.push(`--since=${sinceDate.toISOString()}`);
      }
      const { stdout } = await execFileAsync(
        "git",
        args,
        { cwd: repoRoot, maxBuffer: Infinity },
      );

      // Parse numstat output: "added\tdeleted\tfilepath" per line
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;

        const added = parseInt(parts[0], 10);
        const deleted = parseInt(parts[1], 10);
        const filePath = parts[2];

        if (isNaN(added) || isNaN(deleted)) continue; // binary files show "-"

        const entry = fileMap.get(filePath);
        if (entry) {
          entry.linesAdded += added;
          entry.linesDeleted += deleted;
        }
      }
    } catch (error) {
      // Non-fatal: churn metrics will show 0 for linesAdded/linesDeleted
      console.error("[GitLogReader] numstat enrichment failed:", error instanceof Error ? error.message : error);
    }
  }

  /**
   * Fallback: CLI git log with --numstat and custom format.
   * Single process spawn for the entire repo.
   */
  private async buildViaCli(
    repoRoot: string,
    sinceDate?: Date,
  ): Promise<Map<string, FileChurnData>> {
    const fileMap = new Map<string, FileChurnData>();

    const args = this.buildCliArgs(sinceDate);

    const { stdout } = await execFileAsync(
      "git",
      args,
      { cwd: repoRoot, maxBuffer: Infinity },
    );

    // Parse: each commit starts with \0SHA\0author\0email\0timestamp\0body\0
    // followed by numstat lines until next \0
    const sections = stdout.split("\0");
    let i = 0;

    while (i < sections.length) {
      // Skip empty sections
      if (!sections[i]?.trim()) {
        i++;
        continue;
      }

      // Try to find a commit header: SHA, author, email, timestamp, body
      const sha = sections[i]?.trim();
      if (!sha || sha.length !== 40 || !/^[a-f0-9]+$/.test(sha)) {
        i++;
        continue;
      }

      const author = sections[i + 1] || "";
      const email = sections[i + 2] || "";
      const timestamp = parseInt(sections[i + 3] || "0", 10);
      const body = sections[i + 4] || "";
      i += 5;

      const commitInfo: CommitInfo = { sha, author, authorEmail: email, timestamp, body };

      // Parse numstat lines (they appear between body and next \0SHA)
      // The numstat section is the text before the next commit header
      const numstatSection = sections[i] || "";
      i++;

      for (const line of numstatSection.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;

        const added = parseInt(parts[0], 10);
        const deleted = parseInt(parts[1], 10);
        const filePath = parts[2];

        if (isNaN(added) || isNaN(deleted)) continue;

        let entry = fileMap.get(filePath);
        if (!entry) {
          entry = { commits: [], linesAdded: 0, linesDeleted: 0 };
          fileMap.set(filePath, entry);
        }
        entry.commits.push(commitInfo);
        entry.linesAdded += added;
        entry.linesDeleted += deleted;
      }
    }

    return fileMap;
  }

  /**
   * Read a blob at a specific commit as a UTF-8 string.
   * Returns "" if the file didn't exist at that commit.
   */
  private async readBlobAsString(
    repoRoot: string,
    commitOid: string,
    filepath: string,
  ): Promise<string> {
    try {
      const { blob } = await git.readBlob({
        fs,
        dir: repoRoot,
        oid: commitOid,
        filepath,
        cache: this.cache,
      });
      return new TextDecoder().decode(blob);
    } catch {
      return ""; // file didn't exist at this commit
    }
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
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    // Check HEAD-based cache
    try {
      const headSha = await this.getHead(repoRoot);
      const cached = this.chunkChurnCache.get(repoRoot);
      if (cached && cached.headSha === headSha) {
        return cached.data;
      }
    } catch {
      // If HEAD resolution fails, skip caching and proceed
    }

    const result = await this._buildChunkChurnMapUncached(repoRoot, chunkMap, concurrency, maxAgeMonths);

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
  ): Promise<Array<{ commit: CommitInfo; changedFiles: string[] }>> {
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
  ): Promise<Array<{ commit: CommitInfo; changedFiles: string[] }>> {
    const effectiveTimeoutMs = timeoutMs ?? parseInt(process.env.GIT_LOG_TIMEOUT_MS ?? "30000", 10);
    const args = [
      "log",
      `--since=${sinceDate.toISOString()}`,
      "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00",
      "--numstat",
      "--",
      ...filePaths,
    ];

    const { stdout } = await execFileAsync(
      "git",
      args,
      { cwd: repoRoot, maxBuffer: Infinity, timeout: effectiveTimeoutMs },
    );

    return this.parsePathspecOutput(stdout);
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
  ): Promise<Array<{ commit: CommitInfo; changedFiles: string[] }>> {
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

  private parsePathspecOutput(stdout: string): Array<{ commit: CommitInfo; changedFiles: string[] }> {
    const result: Array<{ commit: CommitInfo; changedFiles: string[] }> = [];
    const sections = stdout.split("\0");
    let i = 0;

    while (i < sections.length) {
      if (!sections[i]?.trim()) { i++; continue; }

      const sha = sections[i]?.trim();
      if (!sha || sha.length !== 40 || !/^[a-f0-9]+$/.test(sha)) { i++; continue; }

      const author = sections[i + 1] || "";
      const email = sections[i + 2] || "";
      const timestamp = parseInt(sections[i + 3] || "0", 10);
      const body = sections[i + 4] || "";
      i += 5;

      const commit: CommitInfo = { sha, author, authorEmail: email, timestamp, body };
      const changedFiles: string[] = [];

      // Parse numstat section
      const numstatSection = sections[i] || "";
      i++;

      for (const line of numstatSection.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        // Binary files show "-\t-" — skip them
        if (parts[0] === "-" && parts[1] === "-") continue;
        changedFiles.push(parts[2]);
      }

      if (changedFiles.length > 0) {
        result.push({ commit, changedFiles });
      }
    }

    return result;
  }

  private async _buildChunkChurnMapUncached(
    repoRoot: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    concurrency: number,
    maxAgeMonths: number,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    const nowSec = Date.now() / 1000;
    const maxFileLines = parseInt(
      process.env.GIT_CHUNK_MAX_FILE_LINES ?? String(MAX_FILE_LINES_DEFAULT),
      10,
    );

    // Build relative path → entries lookup (chunkMap keys may be absolute paths)
    // Also filter: only files with >1 chunk benefit from chunk-level analysis
    const relativeChunkMap = new Map<string, ChunkLookupEntry[]>();
    for (const [filePath, entries] of chunkMap) {
      if (entries.length <= 1) continue; // skip single-chunk files
      const relPath = filePath.startsWith(repoRoot)
        ? filePath.slice(repoRoot.length + 1)
        : filePath;
      relativeChunkMap.set(relPath, entries);
    }

    if (relativeChunkMap.size === 0) {
      return new Map();
    }

    // Per-chunk accumulators
    const accumulators = new Map<
      string,
      {
        commitShas: Set<string>;
        authors: Set<string>;
        bugFixCount: number;
        lastModifiedAt: number;
      }
    >();

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
    let commitEntries: Array<{ commit: CommitInfo; changedFiles: string[] }>;
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
    const queue: Array<() => void> = [];
    const acquire = (): Promise<void> => {
      if (activeCount < concurrency) { activeCount++; return Promise.resolve(); }
      return new Promise<void>((resolve) => queue.push(resolve));
    };
    const release = (): void => {
      const next = queue.shift();
      if (next) { next(); } else { activeCount--; }
    };

    const processCommitEntry = async (entry: { commit: CommitInfo; changedFiles: string[] }): Promise<void> => {
      await acquire();
      try {
        const { commit, changedFiles } = entry;

        // Filter to files we care about (CLI already filtered, but double-check)
        const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
        if (relevantFiles.length === 0) return;

        const isBugFix = BUG_FIX_PATTERN_CHUNK.test(commit.body);

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
            const entries = relativeChunkMap.get(filePath)!;

            const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
            if (maxLine > maxFileLines) { skippedLargeFiles++; return; }

            const [oldContent, newContent] = await Promise.all([
              this.readBlobAsString(repoRoot, parentOid, filePath),
              this.readBlobAsString(repoRoot, commit.sha, filePath),
            ]);
            blobReads += 2;

            if (!oldContent && !newContent) { skippedEmptyBlobs++; return; }

            let hunks: Array<{ newStart: number; newLines: number }>;
            try {
              const patch = structuredPatch(filePath, filePath, oldContent, newContent, "", "");
              hunks = patch.hunks;
              patchCalls++;
            } catch { return; }

            if (hunks.length === 0) return;

            const affectedChunkIds = new Set<string>();
            for (const hunk of hunks) {
              const hunkStart = hunk.newStart;
              const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
              for (const e of entries) {
                if (overlaps(hunkStart, hunkEnd, e.startLine, e.endLine)) {
                  affectedChunkIds.add(e.chunkId);
                }
              }
            }

            for (const chunkId of affectedChunkIds) {
              const acc = accumulators.get(chunkId)!;
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
      const fileCommitShas = new Set<string>();
      for (const entry of entries) {
        const acc = accumulators.get(entry.chunkId)!;
        for (const sha of acc.commitShas) {
          fileCommitShas.add(sha);
        }
      }
      const fileCommitCount = Math.max(fileCommitShas.size, 1);

      const overlayMap = new Map<string, ChunkChurnOverlay>();

      for (const entry of entries) {
        const acc = accumulators.get(entry.chunkId)!;
        const chunkCommitCount = acc.commitShas.size;
        const totalCommitsForChunk = chunkCommitCount || 1;

        overlayMap.set(entry.chunkId, {
          chunkCommitCount,
          chunkChurnRatio: Math.round((chunkCommitCount / fileCommitCount) * 100) / 100,
          chunkContributorCount: acc.authors.size,
          chunkBugFixRate:
            chunkCommitCount > 0
              ? Math.round((acc.bugFixCount / totalCommitsForChunk) * 100)
              : 0,
          chunkLastModifiedAt: acc.lastModifiedAt,
          chunkAgeDays:
            acc.lastModifiedAt > 0
              ? Math.max(0, Math.floor((nowSec - acc.lastModifiedAt) / 86400))
              : 0,
        });
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
  ): Promise<Array<{ commit: CommitInfo; changedFiles: string[] }>> {
    const result: Array<{ commit: CommitInfo; changedFiles: string[] }> = [];

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
        changedFiles = await this.diffTrees(repoRoot, parentOids[0], commit.oid);
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
