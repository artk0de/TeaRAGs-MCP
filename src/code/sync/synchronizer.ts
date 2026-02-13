/**
 * FileSynchronizer - Optimized incremental updates using Merkle trees + mtime caching
 * PERFORMANCE: ~40x faster for incremental updates (40s → <1s)
 *
 * Key optimizations:
 * - mtime + size caching to avoid reading unchanged files
 * - SHA256 computation only for potentially changed files
 * - Backward compatible with old snapshots
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { FileChanges } from "../types.js";
import { MerkleTree } from "./merkle.js";
import { SnapshotManager } from "./snapshot.js";

/**
 * File metadata for fast change detection
 */
interface FileMetadata {
  mtime: number; // Modification timestamp (ms)
  size: number; // File size (bytes)
  hash: string; // SHA256 content hash
}

/**
 * Checkpoint data for resumable indexing
 */
interface Checkpoint {
  processedFiles: string[]; // Relative paths of files already indexed
  totalFiles: number; // Total files to process
  timestamp: number; // When checkpoint was created
  phase: "deleting" | "indexing"; // Current phase
}

export class FileSynchronizer {
  private snapshotManager: SnapshotManager;
  private previousHashes: Map<string, string> = new Map();
  private previousMetadata: Map<string, FileMetadata> = new Map();
  private previousTree: MerkleTree | null = null;
  private checkpointPath: string;
  private collectionName: string;

  constructor(
    private codebasePath: string,
    collectionName: string,
  ) {
    this.collectionName = collectionName;
    // Store snapshots in ~/.tea-rags-mcp/snapshots/
    const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
    const snapshotPath = join(snapshotDir, `${collectionName}.json`);
    this.checkpointPath = join(snapshotDir, `${collectionName}.checkpoint.json`);
    this.snapshotManager = new SnapshotManager(snapshotPath);
  }

  /**
   * Initialize synchronizer by loading previous snapshot
   */
  async initialize(): Promise<boolean> {
    const snapshot = await this.snapshotManager.load();

    if (snapshot) {
      this.previousHashes = snapshot.fileHashes;
      this.previousTree = snapshot.merkleTree;

      // Load metadata if available (v2 snapshots)
      if (snapshot.fileMetadata) {
        this.previousMetadata = snapshot.fileMetadata;
      }

      return true;
    }

    return false;
  }

  /**
   * AUTO-MIGRATION: Upgrade v1 snapshot to v2 by adding metadata
   * Called automatically after initialize() if snapshot is v1
   * This is FAST (only stat calls, no file reading)
   */
  async ensureSnapshotV2(): Promise<boolean> {
    // Check if already v2
    if (this.previousMetadata.size > 0) {
      return false; // Already v2, no migration needed
    }

    // Check if we have v1 snapshot data
    if (this.previousHashes.size === 0) {
      return false; // No snapshot exists
    }

    console.error("[FileSynchronizer] Migrating snapshot v1 → v2...");
    const startTime = Date.now();
    const metadata = new Map<string, FileMetadata>();
    let migratedCount = 0;
    let missingCount = 0;

    // For each file in old snapshot, add metadata
    for (const [relativePath, hash] of this.previousHashes) {
      const absolutePath = join(this.codebasePath, relativePath);

      // Get current mtime + size (fast stat call)
      const meta = await this.getFileMetadata(absolutePath);

      if (meta) {
        metadata.set(relativePath, {
          mtime: meta.mtime,
          size: meta.size,
          hash, // Use existing hash from v1
        });
        migratedCount++;
      } else {
        // File no longer exists, skip it
        missingCount++;
      }
    }

    // Save as v2
    if (metadata.size > 0) {
      const tree = new MerkleTree();
      tree.build(this.previousHashes);
      await this.snapshotManager.save(this.codebasePath, this.previousHashes, tree, metadata);

      // Update internal state
      this.previousMetadata = metadata;
      this.previousTree = tree;

      const duration = Date.now() - startTime;
      console.error(
        `[FileSynchronizer] Migration complete: ${migratedCount} files upgraded ` +
          `(${missingCount} missing) in ${duration}ms`,
      );
      return true;
    }

    return false;
  }

  /**
   * Get file metadata (mtime + size) without reading content
   */
  private async getFileMetadata(filePath: string): Promise<{ mtime: number; size: number } | null> {
    try {
      const absolutePath = filePath.startsWith(this.codebasePath) ? filePath : join(this.codebasePath, filePath);

      const stats = await fs.stat(absolutePath);
      return {
        mtime: stats.mtimeMs,
        size: stats.size,
      };
    } catch (_error) {
      return null;
    }
  }

  /**
   * Compute hash for a file's content
   */
  private async hashFile(filePath: string): Promise<string> {
    try {
      const absolutePath = filePath.startsWith(this.codebasePath) ? filePath : join(this.codebasePath, filePath);
      const content = await fs.readFile(absolutePath, "utf-8");
      return createHash("sha256").update(content).digest("hex");
    } catch (_error) {
      return "";
    }
  }

  /**
   * OPTIMIZED: Compute hashes with mtime/size caching
   * Only reads files that have potentially changed
   */
  async computeFileHashes(filePaths: string[]): Promise<Map<string, string>> {
    const fileHashes = new Map<string, string>();
    let cachedHits = 0;
    let hashComputations = 0;

    for (const filePath of filePaths) {
      const relativePath = filePath.startsWith(this.codebasePath) ? relative(this.codebasePath, filePath) : filePath;

      // Get current metadata
      const metadata = await this.getFileMetadata(filePath);
      if (!metadata) continue;

      // Check if we have cached metadata
      const cached = this.previousMetadata.get(relativePath);

      // FAST PATH: Use cached hash if mtime and size match
      if (
        cached &&
        Math.abs(cached.mtime - metadata.mtime) < 1000 && // 1s tolerance for FS precision
        cached.size === metadata.size
      ) {
        fileHashes.set(relativePath, cached.hash);
        cachedHits++;
        continue;
      }

      // SLOW PATH: Compute hash for changed/new file
      const hash = await this.hashFile(filePath);
      if (hash) {
        fileHashes.set(relativePath, hash);
        hashComputations++;
      }
    }

    // Log performance stats
    if (process.env.DEBUG) {
      console.error(
        `[FileSynchronizer] Cache: ${cachedHits} hits, ${hashComputations} computations ` +
          `(${((cachedHits / (cachedHits + hashComputations)) * 100).toFixed(1)}% cached)`,
      );
    }

    return fileHashes;
  }

  /**
   * OPTIMIZED: Compute full metadata for snapshot
   */
  private async computeFileMetadata(filePaths: string[]): Promise<Map<string, FileMetadata>> {
    const metadata = new Map<string, FileMetadata>();

    for (const filePath of filePaths) {
      const relativePath = filePath.startsWith(this.codebasePath) ? relative(this.codebasePath, filePath) : filePath;

      const meta = await this.getFileMetadata(filePath);
      if (!meta) continue;

      const hash = await this.hashFile(filePath);
      if (!hash) continue;

      metadata.set(relativePath, {
        mtime: meta.mtime,
        size: meta.size,
        hash,
      });
    }

    return metadata;
  }

  /**
   * Detect changes since last snapshot
   * OPTIMIZED: Uses mtime/size for fast filtering
   */
  async detectChanges(currentFiles: string[]): Promise<FileChanges> {
    // Compute current hashes (with caching optimization)
    const currentHashes = await this.computeFileHashes(currentFiles);

    // Compare with previous snapshot
    const changes = MerkleTree.compare(this.previousHashes, currentHashes);

    // DEBUG: Log change detection results
    if (process.env.DEBUG) {
      console.error(
        `[FileSynchronizer] Change detection: ` +
          `${changes.added.length} added, ` +
          `${changes.modified.length} modified, ` +
          `${changes.deleted.length} deleted ` +
          `(from ${currentFiles.length} current files, ${this.previousHashes.size} in snapshot)`,
      );
      if (changes.modified.length > 0 && changes.modified.length <= 10) {
        console.error(`[FileSynchronizer] Modified files: ${changes.modified.join(", ")}`);
      }
    }

    return changes;
  }

  /**
   * Update snapshot with current state
   * OPTIMIZED: Stores metadata for next run
   */
  async updateSnapshot(files: string[]): Promise<void> {
    // Compute full metadata
    const metadata = await this.computeFileMetadata(files);

    // Extract hashes
    const fileHashes = new Map<string, string>();
    for (const [path, meta] of metadata) {
      fileHashes.set(path, meta.hash);
    }

    // Build Merkle tree
    const tree = new MerkleTree();
    tree.build(fileHashes);

    // Save snapshot with metadata (v2 format)
    await this.snapshotManager.save(this.codebasePath, fileHashes, tree, metadata);

    // Update internal state
    this.previousHashes = fileHashes;
    this.previousMetadata = metadata;
    this.previousTree = tree;
  }

  /**
   * Delete snapshot
   */
  async deleteSnapshot(): Promise<void> {
    await this.snapshotManager.delete();
    this.previousHashes.clear();
    this.previousMetadata.clear();
    this.previousTree = null;
  }

  /**
   * Check if snapshot exists
   */
  async hasSnapshot(): Promise<boolean> {
    return this.snapshotManager.exists();
  }

  // ============ CHECKPOINT METHODS ============

  /**
   * Save checkpoint for resumable indexing
   * Call every N files (e.g., every 100 files or 500 chunks)
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
      // Ensure directory exists
      const dir = join(homedir(), ".tea-rags-mcp", "snapshots");
      await fs.mkdir(dir, { recursive: true });

      // Write checkpoint atomically (write to temp, then rename)
      const tempPath = `${this.checkpointPath}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(checkpoint, null, 2));
      await fs.rename(tempPath, this.checkpointPath);

      if (process.env.DEBUG) {
        console.error(`[Checkpoint] Saved: ${processedFiles.length}/${totalFiles} files (${phase})`);
      }
    } catch (error) {
      console.error("[Checkpoint] Failed to save:", error);
      // Non-fatal - continue without checkpoint
    }
  }

  /**
   * Load checkpoint if exists
   * Returns null if no checkpoint or checkpoint is stale
   */
  async loadCheckpoint(): Promise<Checkpoint | null> {
    try {
      const data = await fs.readFile(this.checkpointPath, "utf-8");
      const checkpoint: Checkpoint = JSON.parse(data);

      // Validate checkpoint
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

      console.error(
        `[Checkpoint] Found: ${checkpoint.processedFiles.length}/${checkpoint.totalFiles} ` +
          `files (${checkpoint.phase})`,
      );
      return checkpoint;
    } catch {
      return null;
    }
  }

  /**
   * Delete checkpoint (call after successful completion)
   */
  async deleteCheckpoint(): Promise<void> {
    try {
      await fs.unlink(this.checkpointPath);
    } catch {
      // Ignore - file may not exist
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
   * Validate snapshot integrity
   */
  async validateSnapshot(): Promise<boolean> {
    return this.snapshotManager.validate();
  }

  /**
   * Get snapshot age in milliseconds
   */
  async getSnapshotAge(): Promise<number | null> {
    const snapshot = await this.snapshotManager.load();
    if (!snapshot) return null;

    return Date.now() - snapshot.timestamp;
  }

  /**
   * Quick check if re-indexing is needed (compare root hashes)
   * OPTIMIZED: Uses cached hashes when possible
   */
  async needsReindex(currentFiles: string[]): Promise<boolean> {
    if (!this.previousTree) return true;

    const currentHashes = await this.computeFileHashes(currentFiles);
    const currentTree = new MerkleTree();
    currentTree.build(currentHashes);

    return this.previousTree.getRootHash() !== currentTree.getRootHash();
  }
}
