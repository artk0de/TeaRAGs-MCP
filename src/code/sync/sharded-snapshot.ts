/**
 * ShardedSnapshotManager - Sharded snapshot storage with atomic writes and checksums
 *
 * Features:
 * - Sharded storage for parallel I/O
 * - Atomic directory swap on write
 * - Checksum validation for corruption detection
 * - Two-level Merkle tree (shard + meta)
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";

import { ConsistentHash } from "./consistent-hash.js";
import { MerkleTree } from "./merkle.js";

/**
 * File metadata for fast change detection
 */
export interface FileMetadata {
  mtime: number; // Modification timestamp (ms)
  size: number; // File size (bytes)
  hash: string; // SHA256 content hash
}

/**
 * Meta file format (meta.json)
 */
interface SnapshotMeta {
  version: "3";
  codebasePath: string;
  timestamp: number;
  hashRing: {
    algorithm: "consistent";
    virtualNodesPerShard: number;
    shardCount: number;
  };
  shards: Array<{
    index: number;
    fileCount: number;
    merkleRoot: string;
    checksum: string;
  }>;
  metaRootHash: string;
}

/**
 * Shard file format (shard-XX.json)
 */
interface ShardData {
  shardIndex: number;
  files: Record<string, FileMetadata>;
  merkleRoot: string;
}

/**
 * Loaded snapshot result
 */
export interface LoadedSnapshot {
  codebasePath: string;
  timestamp: number;
  files: Map<string, FileMetadata>;
  shardMerkleRoots: string[];
  metaRootHash: string;
}

export class ShardedSnapshotManager {
  private readonly snapshotDir: string;
  private readonly shardCount: number;
  private readonly virtualNodesPerShard: number;

  constructor(baseDir: string, collectionName: string, shardCount: number = 4, virtualNodesPerShard: number = 150) {
    this.snapshotDir = join(baseDir, collectionName);
    this.shardCount = shardCount;
    this.virtualNodesPerShard = virtualNodesPerShard;
  }

  /**
   * Save files to sharded snapshot
   */
  async save(codebasePath: string, files: Map<string, FileMetadata>): Promise<void> {
    const timestamp = Date.now();
    const tempDir = `${this.snapshotDir}.tmp.${timestamp}`;

    try {
      // Cleanup stale temp directories first
      await this.cleanupStaleTempDirs();

      // Create temp directory
      await fs.mkdir(tempDir, { recursive: true });

      // Distribute files to shards using consistent hashing
      const hashRing = new ConsistentHash(this.shardCount, {
        virtualNodesPerShard: this.virtualNodesPerShard,
      });

      const shardFiles: Map<number, Map<string, FileMetadata>> = new Map();
      for (let i = 0; i < this.shardCount; i++) {
        shardFiles.set(i, new Map());
      }

      for (const [path, metadata] of files) {
        const shardIndex = hashRing.getShard(path);
        shardFiles.get(shardIndex)!.set(path, metadata);
      }

      // Write shards and compute merkle roots
      const shardInfos: SnapshotMeta["shards"] = [];

      for (let i = 0; i < this.shardCount; i++) {
        const filesInShard = shardFiles.get(i)!;

        // Compute merkle root for this shard
        const fileHashes = new Map<string, string>();
        for (const [path, meta] of filesInShard) {
          fileHashes.set(path, meta.hash);
        }
        const merkleTree = new MerkleTree();
        merkleTree.build(fileHashes);
        const merkleRoot = merkleTree.getRootHash() || "";

        // Create shard data
        const shardData: ShardData = {
          shardIndex: i,
          files: Object.fromEntries(filesInShard),
          merkleRoot,
        };

        // Write shard file
        const shardPath = join(tempDir, `shard-${i.toString().padStart(2, "0")}.json`);
        const shardContent = JSON.stringify(shardData, null, 2);
        await fs.writeFile(shardPath, shardContent, "utf-8");

        // Compute checksum
        const checksum = createHash("sha256").update(shardContent).digest("hex");

        shardInfos.push({
          index: i,
          fileCount: filesInShard.size,
          merkleRoot,
          checksum,
        });
      }

      // Compute meta root hash from shard merkle roots
      const shardRootHashes = new Map<string, string>();
      for (const shard of shardInfos) {
        shardRootHashes.set(`shard-${shard.index}`, shard.merkleRoot);
      }
      const metaTree = new MerkleTree();
      metaTree.build(shardRootHashes);
      const metaRootHash = metaTree.getRootHash() || "";

      // Write meta.json
      const meta: SnapshotMeta = {
        version: "3",
        codebasePath,
        timestamp,
        hashRing: {
          algorithm: "consistent",
          virtualNodesPerShard: this.virtualNodesPerShard,
          shardCount: this.shardCount,
        },
        shards: shardInfos,
        metaRootHash,
      };

      const metaPath = join(tempDir, "meta.json");
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

      // Atomic swap: remove old, rename temp to final
      await this.atomicSwap(tempDir, this.snapshotDir);
    } catch (error) {
      // Cleanup temp dir on error
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
      throw error;
    }
  }

  /**
   * Load snapshot from sharded storage
   */
  async load(): Promise<LoadedSnapshot | null> {
    const metaPath = join(this.snapshotDir, "meta.json");

    // Check if snapshot exists
    if (!(await this.exists())) {
      return null;
    }

    // Read and parse meta.json
    let meta: SnapshotMeta;
    try {
      const metaContent = await fs.readFile(metaPath, "utf-8");
      meta = JSON.parse(metaContent);
    } catch (error) {
      throw new Error(`Failed to read meta.json: ${error}`);
    }

    // Load all shards IN PARALLEL for faster initialization
    const files = new Map<string, FileMetadata>();
    const shardMerkleRoots: string[] = new Array(meta.shards.length);

    // OPTIMIZATION: Read all shards concurrently instead of sequentially
    const shardLoadPromises = meta.shards.map(async (shardInfo) => {
      const shardPath = join(this.snapshotDir, `shard-${shardInfo.index.toString().padStart(2, "0")}.json`);

      // Read shard content
      const shardContent = await fs.readFile(shardPath, "utf-8");

      // Validate checksum
      const actualChecksum = createHash("sha256").update(shardContent).digest("hex");
      if (actualChecksum !== shardInfo.checksum) {
        throw new Error(
          `Checksum mismatch for shard ${shardInfo.index}: ` + `expected ${shardInfo.checksum}, got ${actualChecksum}`,
        );
      }

      // Parse shard data
      const shardData: ShardData = JSON.parse(shardContent);

      return { shardInfo, shardData };
    });

    // Wait for all shards to load in parallel
    const loadedShards = await Promise.all(shardLoadPromises);

    // Merge results (preserving shard order for merkle roots)
    for (const { shardInfo, shardData } of loadedShards) {
      // Add files to result
      for (const [path, metadata] of Object.entries(shardData.files)) {
        files.set(path, metadata);
      }

      // Store merkle root at correct index
      shardMerkleRoots[shardInfo.index] = shardData.merkleRoot;
    }

    return {
      codebasePath: meta.codebasePath,
      timestamp: meta.timestamp,
      files,
      shardMerkleRoots,
      metaRootHash: meta.metaRootHash,
    };
  }

  /**
   * Check if snapshot exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(join(this.snapshotDir, "meta.json"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Delete snapshot
   */
  async delete(): Promise<void> {
    try {
      await fs.rm(this.snapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }
  }

  /**
   * Atomic swap: remove old directory, rename temp to final
   */
  private async atomicSwap(tempDir: string, finalDir: string): Promise<void> {
    // Remove existing snapshot if present
    try {
      await fs.rm(finalDir, { recursive: true, force: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Ensure parent directory exists
    await fs.mkdir(dirname(finalDir), { recursive: true });

    // Rename temp to final (atomic on most filesystems)
    await fs.rename(tempDir, finalDir);
  }

  /**
   * Cleanup stale temp directories
   */
  private async cleanupStaleTempDirs(): Promise<void> {
    const parentDir = dirname(this.snapshotDir);

    try {
      const entries = await fs.readdir(parentDir);
      const baseName = this.snapshotDir.split("/").pop()!;

      for (const entry of entries) {
        if (entry.startsWith(`${baseName}.tmp.`)) {
          const tempPath = join(parentDir, entry);
          try {
            await fs.rm(tempPath, { recursive: true, force: true });
          } catch {
            // Ignore individual cleanup errors
          }
        }
      }
    } catch {
      // Parent dir doesn't exist yet, nothing to cleanup
    }
  }
}
