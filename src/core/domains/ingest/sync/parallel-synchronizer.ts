/**
 * ParallelFileSynchronizer - Parallel file change detection using sharded snapshots
 *
 * Features:
 * - Parallel file hashing across shards
 * - mtime+size fast path for unchanged files
 * - Two-level Merkle tree for quick "any changes?" check
 * - Configurable concurrency via INGEST_PIPELINE_CONCURRENCY env
 * - OPTIMIZED: Bounded parallelism to prevent I/O saturation
 * - OPTIMIZED: Hash reuse between detectChanges and updateSnapshot
 */

import { createHash } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { join, relative } from "node:path";

import type { FileChanges } from "../../../types.js";
import { parallelLimit } from "../pipeline/infra/parallel.js";
import { isDebug } from "../pipeline/infra/runtime.js";
import { ConsistentHash } from "./consistent-hash.js";
import { MerkleTree } from "./merkle.js";
import {
  ShardedSnapshotManager,
  type FileMetadata,
  type LoadedSnapshot,
  type SnapshotSaveOptions,
} from "./sharded-snapshot.js";

export { parallelLimit };

/** Default max concurrent I/O operations to prevent filesystem saturation */
const DEFAULT_IO_CONCURRENCY = 50;

/**
 * Checkpoint data for resumable indexing
 */
export interface Checkpoint {
  processedFiles: string[]; // Relative paths of files already indexed
  totalFiles: number; // Total files to process
  timestamp: number; // When checkpoint was created
  phase: "deleting" | "indexing"; // Current phase
}

/**
 * Extended FileChanges with computed hashes for reuse
 */
export interface FileChangesWithHashes extends FileChanges {
  computedHashes: Map<string, FileMetadata>;
}

export class ParallelFileSynchronizer {
  private readonly codebasePath: string;
  private readonly collectionName: string;
  private readonly snapshotDir: string;
  private readonly snapshotManager: ShardedSnapshotManager;
  private readonly concurrency: number;
  private readonly hashRing: ConsistentHash;
  private readonly checkpointPath: string;

  private previousSnapshot: LoadedSnapshot | null = null;

  /** Cached hashes from last detectChanges call for reuse in updateSnapshot */
  private lastComputedHashes: Map<string, FileMetadata> | null = null;

  constructor(
    codebasePath: string,
    collectionName: string,
    snapshotDir: string,
    concurrency?: number,
    private readonly ioConcurrency: number = DEFAULT_IO_CONCURRENCY,
  ) {
    this.codebasePath = codebasePath;
    this.collectionName = collectionName;
    this.snapshotDir = snapshotDir;

    // Get concurrency from param or default
    this.concurrency = concurrency ?? 1;

    this.hashRing = new ConsistentHash(this.concurrency);
    this.snapshotManager = new ShardedSnapshotManager(snapshotDir, collectionName, this.concurrency);
    this.checkpointPath = join(snapshotDir, `${collectionName}.checkpoint.json`);
  }

  /**
   * Get configured concurrency level
   */
  getConcurrency(): number {
    return this.concurrency;
  }

  /**
   * Initialize by loading previous snapshot
   */
  async initialize(): Promise<boolean> {
    const startTime = Date.now();

    this.previousSnapshot = await this.snapshotManager.load();

    if (isDebug()) {
      const elapsed = Date.now() - startTime;
      const fileCount = this.previousSnapshot?.files.size ?? 0;
      console.error(`[Sync] initialize: loaded ${fileCount} files in ${elapsed}ms`);
    }

    return this.previousSnapshot !== null;
  }

  /**
   * Check if snapshot exists
   */
  async hasSnapshot(): Promise<boolean> {
    return this.snapshotManager.exists();
  }

  /**
   * Update snapshot with current files
   * OPTIMIZED: Reuses hashes from detectChanges if available
   */
  async updateSnapshot(
    files: string[],
    precomputedHashes?: Map<string, FileMetadata>,
    options?: SnapshotSaveOptions,
  ): Promise<void> {
    const startTime = Date.now();

    let fileMetadata: Map<string, FileMetadata>;

    if (precomputedHashes) {
      // Use provided hashes (from detectChanges)
      fileMetadata = precomputedHashes;
      if (isDebug()) {
        console.error(`[Sync] updateSnapshot: reusing ${precomputedHashes.size} precomputed hashes`);
      }
    } else if (this.lastComputedHashes) {
      // Use cached hashes from last detectChanges
      fileMetadata = this.lastComputedHashes;
      if (isDebug()) {
        console.error(`[Sync] updateSnapshot: reusing ${this.lastComputedHashes.size} cached hashes`);
      }
    } else {
      // Fallback: compute all hashes (slow path)
      if (isDebug()) {
        console.error(`[Sync] updateSnapshot: computing hashes for ${files.length} files (slow path)`);
      }
      fileMetadata = await this.computeAllFileMetadata(files);
    }

    await this.snapshotManager.save(this.codebasePath, fileMetadata, options);

    // Clear cache after use
    this.lastComputedHashes = null;

    if (isDebug()) {
      console.error(`[Sync] updateSnapshot: saved ${fileMetadata.size} files in ${Date.now() - startTime}ms`);
    }
  }

  /**
   * Detect changes since last snapshot (parallel processing)
   * OPTIMIZED: Uses bounded concurrency and caches computed hashes
   */
  async detectChanges(currentFiles: string[]): Promise<FileChanges> {
    const startTime = Date.now();
    const timings: Record<string, number> = {};

    // Group files by shard
    const groupStart = Date.now();
    const filesByShards = this.groupFilesByShards(currentFiles);
    timings.grouping = Date.now() - groupStart;

    // Process all shards in parallel (each shard uses bounded concurrency internally)
    const processStart = Date.now();
    const shardResults = await Promise.all(
      Array.from(filesByShards.entries()).map(async ([shardIndex, files]) => this.processShardFiles(shardIndex, files)),
    );
    timings.processing = Date.now() - processStart;

    // Merge results from all shards
    const mergeStart = Date.now();
    const changes = this.mergeShardResults(shardResults, currentFiles);
    timings.merging = Date.now() - mergeStart;

    // Classify ignore pattern changes
    const classifyStart = Date.now();
    await this.classifyIgnoreChanges(changes);
    timings.classifying = Date.now() - classifyStart;

    // OPTIMIZATION: Cache computed hashes for reuse in updateSnapshot
    const cacheStart = Date.now();
    this.lastComputedHashes = new Map<string, FileMetadata>();
    for (const result of shardResults) {
      for (const [path, _hash] of result.currentHashes) {
        const meta = result.currentMetadata?.get(path);
        if (meta) {
          this.lastComputedHashes.set(path, meta);
        }
      }
    }
    timings.caching = Date.now() - cacheStart;

    if (isDebug()) {
      const total = Date.now() - startTime;
      console.error(
        `[Sync] detectChanges: ${currentFiles.length} files in ${total}ms ` +
          `(group: ${timings.grouping}ms, process: ${timings.processing}ms, ` +
          `merge: ${timings.merging}ms, classify: ${timings.classifying}ms, cache: ${timings.caching}ms)`,
      );
      console.error(
        `[Sync] detectChanges result: ${changes.added.length} added, ` +
          `${changes.modified.length} modified, ${changes.deleted.length} deleted`,
      );
    }

    return changes;
  }

  /**
   * Quick check if re-indexing is needed (compare merkle roots)
   */
  async needsReindex(currentFiles: string[]): Promise<boolean> {
    if (!this.previousSnapshot) {
      return true;
    }

    // Compute current file hashes
    const currentMetadata = await this.computeAllFileMetadata(currentFiles);

    // Build current merkle tree
    const fileHashes = new Map<string, string>();
    for (const [path, meta] of currentMetadata) {
      fileHashes.set(path, meta.hash);
    }

    // Build merkle tree same way as ShardedSnapshotManager
    const shardRoots = new Map<string, string>();
    const filesByShards = this.groupFilesByShards(currentFiles);

    for (const [shardIndex, files] of filesByShards) {
      const shardHashes = new Map<string, string>();
      for (const file of files) {
        const relativePath = this.toRelativePath(file);
        const meta = currentMetadata.get(relativePath);
        if (meta) {
          shardHashes.set(relativePath, meta.hash);
        }
      }

      const shardTree = new MerkleTree();
      shardTree.build(shardHashes);
      shardRoots.set(`shard-${shardIndex}`, shardTree.getRootHash() || "");
    }

    const metaTree = new MerkleTree();
    metaTree.build(shardRoots);
    const currentMetaRoot = metaTree.getRootHash() || "";

    return currentMetaRoot !== this.previousSnapshot.metaRootHash;
  }

  /**
   * Delete snapshot
   */
  async deleteSnapshot(): Promise<void> {
    await this.snapshotManager.delete();
    this.previousSnapshot = null;
    this.lastComputedHashes = null;
  }

  // ============ CHECKPOINT METHODS ============

  /**
   * Save checkpoint for resumable indexing
   */
  async saveCheckpoint(
    processedFiles: string[],
    totalFiles: number,
    phase: "deleting" | "indexing" = "indexing",
  ): Promise<void> {
    const checkpoint: Checkpoint = {
      processedFiles,
      totalFiles,
      timestamp: Date.now(),
      phase,
    };

    try {
      await fs.mkdir(this.snapshotDir, { recursive: true });
      const tempPath = `${this.checkpointPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(checkpoint, null, 2));
      await fs.rename(tempPath, this.checkpointPath);
    } catch (error) {
      console.error("[Checkpoint] Failed to save:", error);
    }
  }

  /**
   * Load checkpoint if exists
   */
  async loadCheckpoint(): Promise<Checkpoint | null> {
    try {
      const data = await fs.readFile(this.checkpointPath, "utf-8");
      const checkpoint = JSON.parse(data) as Checkpoint;

      if (!checkpoint.processedFiles || !checkpoint.totalFiles) {
        return null;
      }

      // Check if checkpoint is too old (> 24 hours)
      const maxAge = 24 * 60 * 60 * 1000;
      if (Date.now() - checkpoint.timestamp > maxAge) {
        console.error("[Checkpoint] Stale checkpoint (> 24h), ignoring");
        await this.deleteCheckpoint();
        return null;
      }

      return checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Delete checkpoint
   */
  async deleteCheckpoint(): Promise<void> {
    try {
      await fs.unlink(this.checkpointPath);
    } catch {
      // Ignore
    }
  }

  /**
   * Check if checkpoint exists
   */
  async hasCheckpoint(): Promise<boolean> {
    try {
      await fs.access(this.checkpointPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Filter out already processed files based on checkpoint
   */
  filterProcessedFiles(allFiles: string[], checkpoint: Checkpoint): string[] {
    const processedSet = new Set(checkpoint.processedFiles);
    return allFiles.filter((f) => !processedSet.has(f));
  }

  /**
   * Group files by shard index using consistent hashing
   */
  private groupFilesByShards(files: string[]): Map<number, string[]> {
    const result = new Map<number, string[]>();

    for (let i = 0; i < this.concurrency; i++) {
      result.set(i, []);
    }

    for (const file of files) {
      const relativePath = this.toRelativePath(file);
      const shardIndex = this.hashRing.getShard(relativePath);
      const shard = result.get(shardIndex);
      if (shard) {
        shard.push(file);
      }
    }

    return result;
  }

  /**
   * Process files in a single shard
   * OPTIMIZED: Uses bounded concurrency instead of unlimited Promise.all
   */
  private async processShardFiles(shardIndex: number, files: string[]): Promise<ShardResult> {
    const startTime = Date.now();

    const added: string[] = [];
    const modified: string[] = [];
    const currentHashes = new Map<string, string>();
    const currentMetadata = new Map<string, FileMetadata>();

    // OPTIMIZATION: Use bounded concurrency instead of unbounded Promise.all
    const results = await parallelLimit(files, async (file) => this.checkSingleFile(file), this.ioConcurrency);

    for (const result of results) {
      if (!result) continue;

      currentHashes.set(result.relativePath, result.hash);

      // Store full metadata for cache
      if (result.metadata) {
        currentMetadata.set(result.relativePath, result.metadata);
      }

      if (result.status === "added") {
        added.push(result.relativePath);
      } else if (result.status === "modified") {
        modified.push(result.relativePath);
      }
    }

    if (isDebug()) {
      console.error(`[Sync] shard-${shardIndex}: processed ${files.length} files in ${Date.now() - startTime}ms`);
    }

    return { added, modified, currentHashes, currentMetadata };
  }

  /**
   * Check a single file for changes
   * Returns full metadata for caching
   */
  private async checkSingleFile(filePath: string): Promise<FileCheckResult | null> {
    const relativePath = this.toRelativePath(filePath);

    // Get current file metadata
    const currentMeta = await this.getFileMetadata(filePath);
    if (!currentMeta) {
      return null;
    }

    // Check if file existed before
    const previousMeta = this.previousSnapshot?.files.get(relativePath);

    // Compute hash (with mtime+size fast path)
    let hash: string;
    let _usedFastPath = false;

    if (
      previousMeta &&
      Math.abs(previousMeta.mtime - currentMeta.mtime) < 1000 &&
      previousMeta.size === currentMeta.size
    ) {
      // Fast path: mtime and size match, use cached hash
      ({ hash } = previousMeta);
      _usedFastPath = true;
    } else {
      // Slow path: compute hash
      hash = await this.hashFile(filePath);
    }

    // Determine status
    let status: "unchanged" | "added" | "modified";

    if (!previousMeta) {
      status = "added";
    } else if (previousMeta.hash !== hash) {
      status = "modified";
    } else {
      status = "unchanged";
    }

    // Return full metadata for caching
    const metadata: FileMetadata = {
      mtime: currentMeta.mtime,
      size: currentMeta.size,
      hash,
    };

    return { relativePath, hash, status, metadata };
  }

  /**
   * Merge results from all shards
   */
  private mergeShardResults(shardResults: ShardResult[], currentFiles: string[]): FileChanges {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    // Collect added and modified from shard results
    for (const result of shardResults) {
      added.push(...result.added);
      modified.push(...result.modified);
    }

    // Find deleted files (in previous snapshot but not in current files)
    if (this.previousSnapshot) {
      const currentRelativePaths = new Set(currentFiles.map((f) => this.toRelativePath(f)));

      for (const [path] of this.previousSnapshot.files) {
        if (!currentRelativePaths.has(path)) {
          deleted.push(path);
        }
      }
    }

    return { added, modified, deleted, newlyIgnored: [], newlyUnignored: [] };
  }

  /**
   * Classify which added/deleted files are due to ignore pattern changes.
   *
   * - newlyIgnored: files in `deleted` that still exist on disk
   *   (file wasn't removed, scanner excluded it due to new ignore rules)
   * - newlyUnignored: files in `added` whose birthtime predates the
   *   previous snapshot (file existed before but was previously excluded)
   */
  private async classifyIgnoreChanges(changes: FileChanges): Promise<void> {
    // Deleted files that still exist on disk → newly ignored
    for (const relativePath of changes.deleted) {
      const fullPath = join(this.codebasePath, relativePath);
      if (existsSync(fullPath)) {
        changes.newlyIgnored.push(relativePath);
      }
    }

    // Added files that existed before the snapshot → newly unignored
    const snapshotTimestamp = this.previousSnapshot?.timestamp ?? null;
    if (snapshotTimestamp !== null && changes.added.length > 0) {
      const results = await Promise.all(
        changes.added.map(async (relativePath) => {
          try {
            const fileStat = await fs.stat(join(this.codebasePath, relativePath));
            return fileStat.birthtimeMs < snapshotTimestamp ? relativePath : null;
          } catch {
            return null;
          }
        }),
      );
      for (const path of results) {
        if (path !== null) changes.newlyUnignored.push(path);
      }
    }

    if (isDebug() && (changes.newlyIgnored.length > 0 || changes.newlyUnignored.length > 0)) {
      console.error(
        `[Sync] Ignore pattern changes: ${changes.newlyIgnored.length} newly ignored, ${changes.newlyUnignored.length} newly unignored`,
      );
    }
  }

  /**
   * Compute metadata for all files (parallel with bounded concurrency)
   * OPTIMIZED: Uses bounded concurrency instead of unlimited Promise.all
   */
  private async computeAllFileMetadata(files: string[]): Promise<Map<string, FileMetadata>> {
    const startTime = Date.now();

    const results = await parallelLimit(
      files,
      async (file) => {
        const relativePath = this.toRelativePath(file);
        const meta = await this.getFileMetadata(file);

        if (!meta) return null;

        const hash = await this.hashFile(file);

        return {
          relativePath,
          metadata: { mtime: meta.mtime, size: meta.size, hash },
        };
      },
      this.ioConcurrency,
    );

    const metadata = new Map<string, FileMetadata>();
    for (const result of results) {
      if (result) {
        metadata.set(result.relativePath, result.metadata);
      }
    }

    if (isDebug()) {
      console.error(`[Sync] computeAllFileMetadata: ${files.length} files in ${Date.now() - startTime}ms`);
    }

    return metadata;
  }

  /**
   * Get file metadata (mtime + size)
   */
  private async getFileMetadata(filePath: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const absolutePath = filePath.startsWith(this.codebasePath) ? filePath : join(this.codebasePath, filePath);

      const stats = await fs.stat(absolutePath);
      return {
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Compute SHA256 hash of file content
   */
  private async hashFile(filePath: string): Promise<string> {
    try {
      const absolutePath = filePath.startsWith(this.codebasePath) ? filePath : join(this.codebasePath, filePath);

      const content = await fs.readFile(absolutePath, "utf-8");
      return createHash("sha256").update(content).digest("hex");
    } catch {
      return "";
    }
  }

  /**
   * Convert absolute path to relative path
   */
  private toRelativePath(filePath: string): string {
    if (filePath.startsWith(this.codebasePath)) {
      return relative(this.codebasePath, filePath);
    }
    return filePath;
  }
}

interface ShardResult {
  added: string[];
  modified: string[];
  currentHashes: Map<string, string>;
  currentMetadata?: Map<string, FileMetadata>;
}

interface FileCheckResult {
  relativePath: string;
  hash: string;
  status: "unchanged" | "added" | "modified";
  metadata?: FileMetadata;
}
