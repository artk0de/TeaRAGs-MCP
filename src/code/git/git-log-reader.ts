/**
 * GitLogReader — reads git history via isomorphic-git (0 process spawns).
 *
 * Builds per-file FileChurnData from git log in a single pass.
 * Falls back to CLI `git log --all --numstat` if isomorphic-git fails.
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
   * Build per-file FileChurnData from the entire git history.
   * 0 process spawns — reads .git/objects/pack/ directly.
   *
   * Falls back to CLI git log if isomorphic-git fails.
   */
  async buildFileMetadataMap(repoRoot: string): Promise<Map<string, FileChurnData>> {
    // Check HEAD-based cache (non-fatal if HEAD resolution fails)
    let headSha: string | null = null;
    try {
      headSha = await this.getHead(repoRoot);
      const cached = this.fileMetadataCache.get(repoRoot);
      if (cached && cached.headSha === headSha) {
        return cached.data;
      }
    } catch {
      // Not a git repo or HEAD unresolvable — skip caching, proceed to build
    }

    let result: Map<string, FileChurnData>;
    try {
      result = await this.buildViaIsomorphicGit(repoRoot);
    } catch (error) {
      console.error(
        `[GitLogReader] isomorphic-git failed, falling back to CLI:`,
        error instanceof Error ? error.message : error,
      );
      result = await this.buildViaCli(repoRoot);
    }

    // Store in cache if we got a valid HEAD
    if (headSha) {
      this.fileMetadataCache.set(repoRoot, { headSha, data: result });
    }
    return result;
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
   * Primary path: isomorphic-git reads .git directly.
   *
   * Algorithm:
   * 1. Walk all commits via git.log
   * 2. For each pair of consecutive commits, diff the trees
   * 3. Build per-file commit list and numstat via TREE walk
   */
  private async buildViaIsomorphicGit(repoRoot: string): Promise<Map<string, FileChurnData>> {
    const fileMap = new Map<string, FileChurnData>();

    // Get all commits (ordered newest-first)
    const commits = await git.log({
      fs,
      dir: repoRoot,
      ref: "HEAD",
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
    await this.enrichLineStats(repoRoot, fileMap);

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
  ): Promise<void> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--all", "--numstat", "--format="],
        { cwd: repoRoot, maxBuffer: 100 * 1024 * 1024 },
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
  private async buildViaCli(repoRoot: string): Promise<Map<string, FileChurnData>> {
    const fileMap = new Map<string, FileChurnData>();

    const { stdout } = await execFileAsync(
      "git",
      [
        "log",
        "--all",
        "--numstat",
        "--format=%x00%H%x00%an%x00%ae%x00%at%x00%B%x00",
      ],
      { cwd: repoRoot, maxBuffer: 200 * 1024 * 1024 },
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
   * 1. Walk last `depthLimit` commits via isomorphic-git
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
    depthLimit = 200,
    concurrency = 10,
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

    const result = await this._buildChunkChurnMapUncached(repoRoot, chunkMap, depthLimit, concurrency);

    // Store in cache
    try {
      const headSha = await this.getHead(repoRoot);
      this.chunkChurnCache.set(repoRoot, { headSha, data: result });
    } catch {
      // Non-fatal
    }

    return result;
  }

  private async _buildChunkChurnMapUncached(
    repoRoot: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    depthLimit: number,
    concurrency: number,
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
      // Check if filePath is already relative or needs conversion
      const relPath = filePath.startsWith(repoRoot)
        ? filePath.slice(repoRoot.length + 1)
        : filePath;
      relativeChunkMap.set(relPath, entries);
    }

    if (relativeChunkMap.size === 0) {
      return new Map();
    }

    // Per-chunk accumulators: chunkId → { commits: Set<sha>, authors: Set, bugFixes: number, lastModified: number }
    const accumulators = new Map<
      string,
      {
        commitShas: Set<string>;
        authors: Set<string>;
        bugFixCount: number;
        lastModifiedAt: number;
      }
    >();

    // Initialize accumulators for all chunks
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

    // Get commits (newest first)
    let commits: Awaited<ReturnType<typeof git.log>>;
    try {
      commits = await git.log({
        fs,
        dir: repoRoot,
        ref: "HEAD",
        depth: depthLimit,
        cache: this.cache,
      });
    } catch {
      return new Map();
    }

    // Process commits with bounded concurrency using a simple semaphore
    let activeCount = 0;
    const queue: Array<() => void> = [];

    const acquire = (): Promise<void> => {
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

    const processCommit = async (commit: (typeof commits)[0]): Promise<void> => {
      await acquire();
      try {
        const parentOids = commit.commit.parent;
        if (parentOids.length === 0) return; // skip root commit

        const parentOid = parentOids[0];
        let changedFiles: string[];
        try {
          changedFiles = await this.diffTrees(repoRoot, parentOid, commit.oid);
        } catch {
          return;
        }

        // Filter to files we care about
        const relevantFiles = changedFiles.filter((f) => relativeChunkMap.has(f));
        if (relevantFiles.length === 0) return;

        const isBugFix = BUG_FIX_PATTERN_CHUNK.test(commit.commit.message);
        const authorName = commit.commit.author.name;
        const commitTimestamp = commit.commit.author.timestamp;
        const commitSha = commit.oid;

        // Process each relevant file
        await Promise.all(
          relevantFiles.map(async (filePath) => {
            const entries = relativeChunkMap.get(filePath)!;

            // Skip files that are too large (by max endLine of chunks)
            const maxLine = entries.reduce((max, e) => Math.max(max, e.endLine), 0);
            if (maxLine > maxFileLines) return;

            // Read old and new content
            const [oldContent, newContent] = await Promise.all([
              this.readBlobAsString(repoRoot, parentOid, filePath),
              this.readBlobAsString(repoRoot, commit.oid, filePath),
            ]);

            // Skip if both are empty (binary or deleted)
            if (!oldContent && !newContent) return;

            // Generate structured patch to get hunks with line numbers
            let hunks: Array<{ newStart: number; newLines: number }>;
            try {
              const patch = structuredPatch(
                filePath,
                filePath,
                oldContent,
                newContent,
                "",
                "",
              );
              hunks = patch.hunks;
            } catch {
              return;
            }

            if (hunks.length === 0) return;

            // Map hunks to chunks — collect affected chunks first, then update once per commit
            const affectedChunkIds = new Set<string>();
            for (const hunk of hunks) {
              const hunkStart = hunk.newStart;
              const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);

              for (const entry of entries) {
                if (overlaps(hunkStart, hunkEnd, entry.startLine, entry.endLine)) {
                  affectedChunkIds.add(entry.chunkId);
                }
              }
            }

            // Update accumulators once per commit per chunk (avoids multi-hunk double-counting)
            for (const chunkId of affectedChunkIds) {
              const acc = accumulators.get(chunkId)!;
              acc.commitShas.add(commitSha);
              acc.authors.add(authorName);
              if (isBugFix) acc.bugFixCount++;
              if (commitTimestamp > acc.lastModifiedAt) {
                acc.lastModifiedAt = commitTimestamp;
              }
            }
          }),
        );
      } finally {
        release();
      }
    };

    // Process all commits in parallel (bounded by concurrency)
    await Promise.all(commits.map(processCommit));

    // Build result map: relativePath → Map<chunkId, ChunkChurnOverlay>
    const result = new Map<string, Map<string, ChunkChurnOverlay>>();

    for (const [relPath, entries] of relativeChunkMap) {
      // Get file-level commit count for ratio calculation
      // We need to count total unique commits for this file across all chunks
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
        const totalCommitsForChunk = chunkCommitCount || 1; // avoid division by zero

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

    return result;
  }
}
