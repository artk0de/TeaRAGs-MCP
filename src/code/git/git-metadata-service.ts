/**
 * GitMetadataService - Canonical algorithm implementation
 *
 * ALGORITHM (from spec):
 * 1. Parse file with tree-sitter (done externally)
 * 2. Run git blame ONCE per file
 * 3. Build line-level blame map
 * 4. For each chunk: aggregate blame over line range
 * 5. Attach aggregated git metadata to chunk
 *
 * CONSTRAINTS:
 * - Git blame executed at most once per file
 * - No per-line or per-chunk git commands
 * - Cache by content hash (not mtime)
 * - No commit message parsing
 *
 * ANTI-PATTERNS AVOIDED:
 * - Running git blame per chunk ❌
 * - Running git blame per symbol ❌
 * - Storing full line-by-line blame in vector DB ❌
 * - Using commit messages as semantic signal ❌
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import type {
  BlameCache,
  BlameCacheFile,
  BlameLineData,
  GitChunkMetadata,
  GitMetadataOptions,
  GitRepoInfo,
} from "./types.js";

const execFileAsync = promisify(execFile);

const CACHE_VERSION = 4;

export class GitMetadataService {
  private readonly cacheDir: string;
  private readonly debug: boolean;

  // In-memory caches (L1)
  private blameCache = new Map<string, BlameCache>();
  private repoRootCache = new Map<string, GitRepoInfo>();
  private contentHashCache = new Map<string, string>();
  /** Cache of commit SHA -> full body (for extracting taskIds from merge/squash commits) */
  private commitBodyCache = new Map<string, Map<string, string>>();

  // Stats for debugging
  private stats = {
    cacheHitsL1: 0,
    cacheHitsL2: 0,
    cacheMisses: 0,
    blameExecutions: 0,
    logExecutions: 0,
    chunksProcessed: 0,
  };

  constructor(options?: GitMetadataOptions) {
    this.cacheDir =
      options?.cacheDir ?? join(homedir(), ".qdrant-mcp", "git-cache");
    this.debug =
      options?.debug ?? (process.env.DEBUG === "true" || process.env.DEBUG === "1");
    if (this.debug) {
      console.log(`[GitMetadata] Service initialized (cacheDir=${this.cacheDir})`);
    }
  }

  /**
   * Initialize cache directory
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.cacheDir, { recursive: true });
    if (this.debug) {
      console.log(`[GitMetadata] Cache directory ready: ${this.cacheDir}`);
    }
  }

  /**
   * Get aggregated git metadata for a chunk
   *
   * @param filePath Absolute path to file
   * @param startLine 1-based start line
   * @param endLine 1-based end line
   * @param fileContent File content (for hash-based caching)
   */
  async getChunkMetadata(
    filePath: string,
    startLine: number,
    endLine: number,
    fileContent?: string,
  ): Promise<GitChunkMetadata | null> {
    this.stats.chunksProcessed++;
    const startTime = this.debug ? Date.now() : 0;
    
    // Step 1: Check if in git repo
    const repoInfo = await this.getRepoInfo(filePath);
    if (!repoInfo.isGitRepo) {
      return null;
    }

    try {
      // Step 2: Get blame map for file (cached by content hash)
      const blameMap = await this.getBlameMap(filePath, repoInfo.repoRoot, fileContent);
      if (!blameMap || blameMap.lines.size === 0) {
        return null;
      }

      // Step 3: Aggregate blame data over chunk line range
      const result = this.aggregateBlameForRange(blameMap, startLine, endLine);
      
      if (this.debug && result) {
        const elapsed = Date.now() - startTime;
        console.log(
          `[GitMetadata] Chunk L${startLine}-${endLine}: ` +
          `author=${result.dominantAuthor}, commits=${result.commitCount}, ` +
          `taskIds=[${result.taskIds.join(',')}], age=${result.ageDays}d (${elapsed}ms)`
        );
      }
      
      return result;
    } catch (error) {
      if (this.debug) {
        console.error(`[GitMetadata] Error for ${filePath}:`, error);
      }
      return null;
    }
  }

  /**
   * Prefetch git blame data for multiple files in parallel.
   * This warms the L1 cache so subsequent getChunkMetadata calls are instant.
   *
   * OPTIMIZATION: Call this before processing chunks to avoid
   * sequential git blame blocking during chunk enrichment.
   *
   * @param filePaths Array of absolute file paths
   * @param fileContents Optional map of filePath -> content (avoids re-reading)
   * @param concurrency Max parallel git blame processes (default: 10)
   */
  async prefetchBlame(
    filePaths: string[],
    fileContents?: Map<string, string>,
    concurrency = 10,
  ): Promise<{ prefetched: number; failed: number }> {
    if (filePaths.length === 0) {
      return { prefetched: 0, failed: 0 };
    }

    const startTime = this.debug ? Date.now() : 0;

    // Get repo info from first file (assume all files in same repo)
    const repoInfo = await this.getRepoInfo(filePaths[0]);
    if (!repoInfo.isGitRepo) {
      return { prefetched: 0, failed: 0 };
    }

    let prefetched = 0;
    let failed = 0;

    // Process in batches with bounded concurrency
    for (let i = 0; i < filePaths.length; i += concurrency) {
      const batch = filePaths.slice(i, i + concurrency);

      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const content = fileContents?.get(filePath);
          const blameMap = await this.getBlameMap(filePath, repoInfo.repoRoot, content);
          return blameMap !== null;
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          prefetched++;
        } else if (result.status === "rejected") {
          failed++;
        }
      }
    }

    if (this.debug) {
      const elapsed = Date.now() - startTime;
      console.log(
        `[GitMetadata] Prefetch complete: ${filePaths.length} files in ${elapsed}ms ` +
        `(${prefetched} ok, ${failed} failed)`,
      );
    }

    return { prefetched, failed };
  }

  /**
   * Aggregate blame data for a line range
   * This produces the ONLY git data stored per chunk
   */
  private aggregateBlameForRange(
    blameMap: BlameCache,
    startLine: number,
    endLine: number,
  ): GitChunkMetadata | null {
    const authorLineCounts = new Map<string, { count: number; email: string }>();
    const commits = new Set<string>();
    const allTaskIds = new Set<string>();
    let maxAuthorTime = 0;
    let minAuthorTime = Infinity;
    let lastCommitHash = "";
    let lastCommitTime = 0;

    // Iterate over line range
    for (let line = startLine; line <= endLine; line++) {
      const lineData = blameMap.lines.get(line);
      if (!lineData) continue;

      // Track commits
      commits.add(lineData.commit);

      // Track task IDs from this line's commit
      if (lineData.taskIds) {
        for (const taskId of lineData.taskIds) {
          allTaskIds.add(taskId);
        }
      }

      // Track author line counts for dominant author
      const existing = authorLineCounts.get(lineData.author);
      if (existing) {
        existing.count++;
      } else {
        authorLineCounts.set(lineData.author, {
          count: 1,
          email: lineData.authorEmail,
        });
      }

      // Track max/min time
      if (lineData.authorTime > maxAuthorTime) {
        maxAuthorTime = lineData.authorTime;
      }
      if (lineData.authorTime < minAuthorTime) {
        minAuthorTime = lineData.authorTime;
      }

      // Track most recent commit
      if (lineData.authorTime > lastCommitTime) {
        lastCommitTime = lineData.authorTime;
        lastCommitHash = lineData.commit;
      }
    }

    if (authorLineCounts.size === 0) {
      return null;
    }

    // Find dominant author (most lines)
    let dominantAuthor = "";
    let dominantAuthorEmail = "";
    let maxLines = 0;
    for (const [author, data] of authorLineCounts) {
      if (data.count > maxLines) {
        maxLines = data.count;
        dominantAuthor = author;
        dominantAuthorEmail = data.email;
      }
    }

    // Calculate age in days
    const now = Math.floor(Date.now() / 1000);
    const ageDays = Math.floor((now - maxAuthorTime) / (60 * 60 * 24));

    return {
      lastModifiedAt: maxAuthorTime,
      firstCreatedAt: minAuthorTime === Infinity ? maxAuthorTime : minAuthorTime,
      dominantAuthor,
      dominantAuthorEmail,
      authors: Array.from(authorLineCounts.keys()),
      commitCount: commits.size,
      lastCommitHash,
      ageDays: Math.max(0, ageDays),
      taskIds: Array.from(allTaskIds),
    };
  }

  /**
   * Get blame map for a file (cached by content hash)
   */
  private async getBlameMap(
    filePath: string,
    repoRoot: string,
    fileContent?: string,
  ): Promise<BlameCache | null> {
    // Compute content hash for cache key
    const content = fileContent ?? (await fs.readFile(filePath, "utf-8"));
    const contentHash = this.computeContentHash(content);
    const cacheKey = `${repoRoot}:${relative(repoRoot, filePath)}`;

    // Check L1 (memory) cache
    const memoryCached = this.blameCache.get(cacheKey);
    if (memoryCached && memoryCached.contentHash === contentHash) {
      this.stats.cacheHitsL1++;
      if (this.debug) {
        console.log(`[GitMetadata] L1 cache hit: ${relative(repoRoot, filePath)} (${memoryCached.lines.size} lines)`);
      }
      return memoryCached;
    }

    // Check L2 (disk) cache
    const diskCached = await this.loadFromDisk(repoRoot, filePath, contentHash);
    if (diskCached) {
      this.stats.cacheHitsL2++;
      this.blameCache.set(cacheKey, diskCached);
      if (this.debug) {
        console.log(`[GitMetadata] L2 cache hit: ${relative(repoRoot, filePath)} (${diskCached.lines.size} lines)`);
      }
      return diskCached;
    }

    // Run git blame + git log in PARALLEL (for full commit bodies)
    this.stats.cacheMisses++;
    if (this.debug) {
      console.log(`[GitMetadata] Cache miss, running git blame + log: ${relative(repoRoot, filePath)}`);
    }
    const startTime = this.debug ? Date.now() : 0;

    const [blameData, commitBodies] = await Promise.all([
      this.runGitBlame(filePath, repoRoot),
      this.getCommitBodies(filePath, repoRoot),
    ]);

    if (!blameData) {
      return null;
    }

    // Enrich taskIds from full commit bodies (for merge/squash commits)
    this.enrichTaskIdsFromBodies(blameData, commitBodies);

    if (this.debug) {
      const elapsed = Date.now() - startTime;
      console.log(`[GitMetadata] Blame+log completed: ${relative(repoRoot, filePath)} (${blameData.size} lines, ${elapsed}ms)`);
    }

    const cache: BlameCache = {
      contentHash,
      lines: blameData,
      cachedAt: Date.now(),
    };

    // Store in L1
    this.blameCache.set(cacheKey, cache);

    // Store in L2 (async, non-blocking)
    this.saveToDisk(repoRoot, filePath, cache).catch((err) => {
      if (this.debug) console.error(`[GitMetadata] Cache save failed:`, err);
    });

    return cache;
  }

  /**
   * Run git blame ONCE per file
   * Returns line number -> blame data map
   */
  private async runGitBlame(
    filePath: string,
    repoRoot: string,
  ): Promise<Map<number, BlameLineData> | null> {
    this.stats.blameExecutions++;
    try {
      const relativePath = relative(repoRoot, filePath);

      const { stdout } = await execFileAsync(
        "git",
        ["blame", "--porcelain", "-w", relativePath],
        { cwd: repoRoot, maxBuffer: 50 * 1024 * 1024 },
      );

      return this.parseBlameOutput(stdout);
    } catch (error) {
      if (this.debug) {
        console.error(`[GitMetadata] git blame failed:`, error);
      }
      return null;
    }
  }

  /**
   * Get commit bodies for a file (for extracting taskIds from full commit messages)
   * Returns Map<commitSha, fullBody>
   */
  private async getCommitBodies(
    filePath: string,
    repoRoot: string,
  ): Promise<Map<string, string>> {
    const cacheKey = `${repoRoot}:${relative(repoRoot, filePath)}`;

    // Check cache
    const cached = this.commitBodyCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    this.stats.logExecutions++;
    try {
      const relativePath = relative(repoRoot, filePath);

      // Use NULL byte as separator to handle multi-line commit messages
      const { stdout } = await execFileAsync(
        "git",
        ["log", "--format=%H%x00%B%x00", "--", relativePath],
        { cwd: repoRoot, maxBuffer: 50 * 1024 * 1024 },
      );

      const bodies = this.parseLogOutput(stdout);
      this.commitBodyCache.set(cacheKey, bodies);

      if (this.debug) {
        console.log(`[GitMetadata] Loaded ${bodies.size} commit bodies for ${relativePath}`);
      }

      return bodies;
    } catch (error) {
      if (this.debug) {
        console.error(`[GitMetadata] git log failed:`, error);
      }
      return new Map();
    }
  }

  /**
   * Parse git log output into Map<sha, fullBody>
   * Format: SHA\0BODY\0SHA\0BODY\0...
   */
  private parseLogOutput(output: string): Map<string, string> {
    const bodies = new Map<string, string>();

    // Split by NULL byte, filter empty
    const parts = output.split("\0").filter(p => p.trim());

    for (let i = 0; i < parts.length - 1; i += 2) {
      const sha = parts[i].trim();
      const body = parts[i + 1] || "";
      if (sha.length === 40) {
        bodies.set(sha, body);
      }
    }

    return bodies;
  }

  /**
   * Enrich taskIds from full commit bodies for commits where summary didn't have taskIds.
   * This handles merge/squash commits where taskIds are in the body, not the first line.
   *
   * Mutates blameData in place.
   */
  private enrichTaskIdsFromBodies(
    blameData: Map<number, BlameLineData>,
    commitBodies: Map<string, string>,
  ): void {
    // Collect unique commits that need enrichment (no taskIds from summary)
    const commitsNeedingEnrichment = new Set<string>();
    for (const lineData of blameData.values()) {
      if (!lineData.taskIds || lineData.taskIds.length === 0) {
        commitsNeedingEnrichment.add(lineData.commit);
      }
    }

    if (commitsNeedingEnrichment.size === 0) {
      return;
    }

    // Build enriched taskIds map for commits needing it
    const enrichedTaskIds = new Map<string, string[]>();
    for (const commit of commitsNeedingEnrichment) {
      const body = commitBodies.get(commit);
      if (body) {
        const taskIds = this.extractTaskIds(body);
        if (taskIds.length > 0) {
          enrichedTaskIds.set(commit, taskIds);
        }
      }
    }

    if (enrichedTaskIds.size === 0) {
      return;
    }

    // Update blameData with enriched taskIds
    for (const lineData of blameData.values()) {
      if (!lineData.taskIds || lineData.taskIds.length === 0) {
        const enriched = enrichedTaskIds.get(lineData.commit);
        if (enriched) {
          lineData.taskIds = enriched;
        }
      }
    }

    if (this.debug) {
      console.log(`[GitMetadata] Enriched ${enrichedTaskIds.size} commits with taskIds from body`);
    }
  }

  /**
   * Parse git blame porcelain output into line map
   *
   * Porcelain format:
   * <sha1> <orig-line> <final-line> [<num-lines>]
   * author <name>
   * author-mail <email>
   * author-time <timestamp>
   * summary <first line of commit message>
   * ...
   * \t<content>
   */
  private parseBlameOutput(output: string): Map<number, BlameLineData> {
    const lines = new Map<number, BlameLineData>();
    const commitCache = new Map<
      string,
      { author: string; authorEmail: string; authorTime: number; taskIds: string[] }
    >();

    const outputLines = output.split("\n");
    let i = 0;
    let currentLine = 0;

    while (i < outputLines.length) {
      const headerLine = outputLines[i];
      if (!headerLine) {
        i++;
        continue;
      }

      // Header: <sha1> <orig-line> <final-line> [<num-lines>]
      const headerMatch = headerLine.match(
        /^([a-f0-9]{40})\s+\d+\s+(\d+)/,
      );
      if (!headerMatch) {
        i++;
        continue;
      }

      const commit = headerMatch[1];
      currentLine = parseInt(headerMatch[2], 10);

      // Check commit cache
      let commitInfo = commitCache.get(commit);

      if (!commitInfo) {
        // Parse commit info from following lines
        let author = "";
        let authorEmail = "";
        let authorTime = 0;
        let summary = "";

        i++;
        while (i < outputLines.length && !outputLines[i].startsWith("\t")) {
          const line = outputLines[i];
          if (line.startsWith("author ")) {
            author = line.substring(7);
          } else if (line.startsWith("author-mail ")) {
            // Remove < > brackets from email
            authorEmail = line.substring(12).replace(/[<>]/g, "");
          } else if (line.startsWith("author-time ")) {
            authorTime = parseInt(line.substring(12), 10);
          } else if (line.startsWith("summary ")) {
            summary = line.substring(8);
          }
          i++;
        }

        // Extract task IDs from commit summary
        const taskIds = this.extractTaskIds(summary);

        commitInfo = { author, authorEmail, authorTime, taskIds };
        commitCache.set(commit, commitInfo);
      } else {
        // Skip to content line
        i++;
        while (i < outputLines.length && !outputLines[i].startsWith("\t")) {
          i++;
        }
      }

      // Store line data
      lines.set(currentLine, {
        commit,
        author: commitInfo.author,
        authorEmail: commitInfo.authorEmail,
        authorTime: commitInfo.authorTime,
        taskIds: commitInfo.taskIds.length > 0 ? commitInfo.taskIds : undefined,
      });

      // Skip content line
      if (i < outputLines.length && outputLines[i].startsWith("\t")) {
        i++;
      }
    }

    return lines;
  }

  /**
   * Extract task IDs from commit summary
   *
   * Supported formats:
   * - JIRA/Linear style: TD-1234, ENG-567, PROJ-890
   * - GitHub style: #123, fixes #456
   * - Azure DevOps: AB#789
   * - GitLab MR: !123
   *
   * Returns deduplicated array of task IDs
   */
  private extractTaskIds(summary: string): string[] {
    if (!summary) return [];

    const taskIds = new Set<string>();

    // JIRA/Linear style: ABC-123 (2-10 uppercase letters, dash, 1-6 digits)
    const jiraPattern = /\b([A-Z]{2,10}-\d{1,6})\b/g;
    let match;
    while ((match = jiraPattern.exec(summary)) !== null) {
      taskIds.add(match[1]);
    }

    // GitHub style: #123 (hash followed by digits)
    const githubPattern = /(?:^|[^&])#(\d{1,7})\b/g;
    while ((match = githubPattern.exec(summary)) !== null) {
      taskIds.add(`#${match[1]}`);
    }

    // Azure DevOps: AB#123
    const azurePattern = /\bAB#(\d{1,7})\b/g;
    while ((match = azurePattern.exec(summary)) !== null) {
      taskIds.add(`AB#${match[1]}`);
    }

    // GitLab MR: !123
    const gitlabPattern = /!(\d{1,7})\b/g;
    while ((match = gitlabPattern.exec(summary)) !== null) {
      taskIds.add(`!${match[1]}`);
    }

    return Array.from(taskIds);
  }

  /**
   * Check if path is in a git repository
   */
  async getRepoInfo(filePath: string): Promise<GitRepoInfo> {
    const dirPath = dirname(filePath);

    const cached = this.repoRootCache.get(dirPath);
    if (cached) return cached;

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", "--show-toplevel"],
        { cwd: dirPath, maxBuffer: 1024 * 1024 },
      );

      const info: GitRepoInfo = { repoRoot: stdout.trim(), isGitRepo: true };
      this.repoRootCache.set(dirPath, info);
      return info;
    } catch {
      const info: GitRepoInfo = { repoRoot: "", isGitRepo: false };
      this.repoRootCache.set(dirPath, info);
      return info;
    }
  }

  /**
   * Compute SHA-256 hash of content
   */
  private computeContentHash(content: string): string {
    return createHash("sha256").update(content).digest("hex").substring(0, 16);
  }

  /**
   * Get cache file path
   */
  private getCacheFilePath(repoRoot: string, filePath: string): string {
    const repoHash = createHash("md5").update(repoRoot).digest("hex").substring(0, 8);
    const fileHash = createHash("md5")
      .update(relative(repoRoot, filePath))
      .digest("hex")
      .substring(0, 12);
    return join(this.cacheDir, repoHash, `${fileHash}.json`);
  }

  /**
   * Load blame cache from disk (if content hash matches)
   */
  private async loadFromDisk(
    repoRoot: string,
    filePath: string,
    contentHash: string,
  ): Promise<BlameCache | null> {
    try {
      const cachePath = this.getCacheFilePath(repoRoot, filePath);
      const data = await fs.readFile(cachePath, "utf-8");
      const cached: BlameCacheFile = JSON.parse(data);

      // Validate cache
      if (cached.version !== CACHE_VERSION || cached.contentHash !== contentHash) {
        return null;
      }

      // Convert to BlameCache
      const lines = new Map<number, BlameLineData>();
      for (const [lineNum, commit, author, authorEmail, authorTime, taskIds] of cached.lines) {
        lines.set(lineNum, {
          commit,
          author,
          authorEmail,
          authorTime,
          taskIds: taskIds?.length ? taskIds : undefined,
        });
      }

      return {
        contentHash: cached.contentHash,
        lines,
        cachedAt: cached.cachedAt,
      };
    } catch {
      return null;
    }
  }

  /**
   * Save blame cache to disk
   */
  private async saveToDisk(
    repoRoot: string,
    filePath: string,
    cache: BlameCache,
  ): Promise<void> {
    const cachePath = this.getCacheFilePath(repoRoot, filePath);
    await fs.mkdir(dirname(cachePath), { recursive: true });

    // Convert to serializable format (6-tuple with taskIds)
    const lines: Array<[number, string, string, string, number, string[]]> = [];
    for (const [lineNum, data] of cache.lines) {
      lines.push([
        lineNum,
        data.commit,
        data.author,
        data.authorEmail,
        data.authorTime,
        data.taskIds ?? [],
      ]);
    }

    const cacheFile: BlameCacheFile = {
      version: CACHE_VERSION,
      contentHash: cache.contentHash,
      cachedAt: cache.cachedAt,
      lines,
    };

    await fs.writeFile(cachePath, JSON.stringify(cacheFile), "utf-8");
  }

  /**
   * Get cache statistics (for debugging)
   */
  getStats(): typeof this.stats {
    return { ...this.stats };
  }

  /**
   * Print cache statistics
   */
  printStats(): void {
    console.log('[GitMetadata] Statistics:');
    console.log(`  L1 cache hits: ${this.stats.cacheHitsL1}`);
    console.log(`  L2 cache hits: ${this.stats.cacheHitsL2}`);
    console.log(`  Cache misses:  ${this.stats.cacheMisses}`);
    console.log(`  Blame calls:   ${this.stats.blameExecutions}`);
    console.log(`  Chunks:        ${this.stats.chunksProcessed}`);
    const total = this.stats.cacheHitsL1 + this.stats.cacheHitsL2 + this.stats.cacheMisses;
    const hitRate = total > 0 ? ((this.stats.cacheHitsL1 + this.stats.cacheHitsL2) / total * 100).toFixed(1) : '0.0';
    console.log(`  Hit rate:      ${hitRate}%`);
  }

  /**
   * Clear all caches
   */
  clearCaches(): void {
    this.blameCache.clear();
    this.repoRootCache.clear();
    this.contentHashCache.clear();
    if (this.debug) {
      console.log('[GitMetadata] All caches cleared');
    }
  }

  /**
   * Clear disk cache for a repository
   */
  async clearDiskCache(repoRoot: string): Promise<void> {
    const repoHash = createHash("md5").update(repoRoot).digest("hex").substring(0, 8);
    const repoCacheDir = join(this.cacheDir, repoHash);
    await fs.rm(repoCacheDir, { recursive: true, force: true }).catch(() => {});
    if (this.debug) {
      console.log(`[GitMetadata] Disk cache cleared for: ${repoRoot}`);
    }
  }
}
