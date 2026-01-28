/**
 * ParallelFileSynchronizer - Parallel file change detection using sharded snapshots
 *
 * Features:
 * - Parallel file hashing across shards
 * - mtime+size fast path for unchanged files
 * - Two-level Merkle tree for quick "any changes?" check
 * - Configurable concurrency via EMBEDDING_CONCURRENCY env
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { relative, join } from "node:path";
import type { FileChanges } from "../types.js";
import { ConsistentHash } from "./consistent-hash.js";
import { MerkleTree } from "./merkle.js";
import { ShardedSnapshotManager, type FileMetadata, type LoadedSnapshot } from "./sharded-snapshot.js";

/**
 * Checkpoint data for resumable indexing
 */
export interface Checkpoint {
  processedFiles: string[];  // Relative paths of files already indexed
  totalFiles: number;        // Total files to process
  timestamp: number;         // When checkpoint was created
  phase: "deleting" | "indexing";  // Current phase
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

  constructor(
    codebasePath: string,
    collectionName: string,
    snapshotDir: string,
    concurrency?: number
  ) {
    this.codebasePath = codebasePath;
    this.collectionName = collectionName;
    this.snapshotDir = snapshotDir;

    // Get concurrency from param, env, or default
    this.concurrency = concurrency
      ?? parseInt(process.env.EMBEDDING_CONCURRENCY || "4", 10);

    this.hashRing = new ConsistentHash(this.concurrency);
    this.snapshotManager = new ShardedSnapshotManager(
      snapshotDir,
      collectionName,
      this.concurrency
    );
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
    this.previousSnapshot = await this.snapshotManager.load();
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
   */
  async updateSnapshot(files: string[]): Promise<void> {
    const fileMetadata = await this.computeAllFileMetadata(files);
    await this.snapshotManager.save(this.codebasePath, fileMetadata);
  }

  /**
   * Detect changes since last snapshot (parallel processing)
   */
  async detectChanges(currentFiles: string[]): Promise<FileChanges> {
    // Group files by shard
    const filesByShards = this.groupFilesByShards(currentFiles);

    // Process all shards in parallel
    const shardResults = await Promise.all(
      Array.from(filesByShards.entries()).map(([shardIndex, files]) =>
        this.processShardFiles(shardIndex, files)
      )
    );

    // Merge results from all shards
    return this.mergeShardResults(shardResults, currentFiles);
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
  }

  // ============ CHECKPOINT METHODS ============

  /**
   * Save checkpoint for resumable indexing
   */
  async saveCheckpoint(
    processedFiles: string[],
    totalFiles: number,
    phase: "deleting" | "indexing" = "indexing"
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
      const checkpoint: Checkpoint = JSON.parse(data);

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
      result.get(shardIndex)!.push(file);
    }

    return result;
  }

  /**
   * Process files in a single shard
   */
  private async processShardFiles(
    _shardIndex: number,
    files: string[]
  ): Promise<ShardResult> {
    const added: string[] = [];
    const modified: string[] = [];
    const currentHashes = new Map<string, string>();

    // Process files in parallel within the shard
    const results = await Promise.all(
      files.map(file => this.checkSingleFile(file))
    );

    for (const result of results) {
      if (!result) continue;

      currentHashes.set(result.relativePath, result.hash);

      if (result.status === "added") {
        added.push(result.relativePath);
      } else if (result.status === "modified") {
        modified.push(result.relativePath);
      }
    }

    return { added, modified, currentHashes };
  }

  /**
   * Check a single file for changes
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

    if (
      previousMeta &&
      Math.abs(previousMeta.mtime - currentMeta.mtime) < 1000 &&
      previousMeta.size === currentMeta.size
    ) {
      // Fast path: mtime and size match, use cached hash
      hash = previousMeta.hash;
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

    return { relativePath, hash, status };
  }

  /**
   * Merge results from all shards
   */
  private mergeShardResults(
    shardResults: ShardResult[],
    currentFiles: string[]
  ): FileChanges {
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
      const currentRelativePaths = new Set(
        currentFiles.map(f => this.toRelativePath(f))
      );

      for (const [path] of this.previousSnapshot.files) {
        if (!currentRelativePaths.has(path)) {
          deleted.push(path);
        }
      }
    }

    return { added, modified, deleted };
  }

  /**
   * Compute metadata for all files (parallel)
   */
  private async computeAllFileMetadata(
    files: string[]
  ): Promise<Map<string, FileMetadata>> {
    const results = await Promise.all(
      files.map(async file => {
        const relativePath = this.toRelativePath(file);
        const meta = await this.getFileMetadata(file);

        if (!meta) return null;

        const hash = await this.hashFile(file);

        return {
          relativePath,
          metadata: { mtime: meta.mtime, size: meta.size, hash },
        };
      })
    );

    const metadata = new Map<string, FileMetadata>();
    for (const result of results) {
      if (result) {
        metadata.set(result.relativePath, result.metadata);
      }
    }

    return metadata;
  }

  /**
   * Get file metadata (mtime + size)
   */
  private async getFileMetadata(
    filePath: string
  ): Promise<{ mtime: number; size: number } | null> {
    try {
      const absolutePath = filePath.startsWith(this.codebasePath)
        ? filePath
        : join(this.codebasePath, filePath);

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
      const absolutePath = filePath.startsWith(this.codebasePath)
        ? filePath
        : join(this.codebasePath, filePath);

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
}

interface FileCheckResult {
  relativePath: string;
  hash: string;
  status: "unchanged" | "added" | "modified";
}
