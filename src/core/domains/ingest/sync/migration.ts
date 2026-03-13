/**
 * SnapshotMigrator - Migrates v1/v2 snapshots to v3 sharded format
 *
 * Migration strategy:
 * 1. Detect old format (single JSON file)
 * 2. Read and parse old snapshot
 * 3. Create backup of old file
 * 4. Write new sharded format
 * 5. Delete old file (keep backup)
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { ShardedSnapshotManager, type FileMetadata } from "./sharded-snapshot.js";

/**
 * Old snapshot format (v1 or v2)
 */
interface OldSnapshot {
  version?: "2";
  codebasePath: string;
  timestamp: number;
  fileHashes: Record<string, string>;
  fileMetadata?: Record<string, FileMetadata>;
  merkleTree: string;
}

/**
 * Migration result
 */
export interface MigrationResult {
  success: boolean;
  filesCount: number;
  skippedCount: number;
  alreadyMigrated: boolean;
  error?: string;
}

export class SnapshotMigrator {
  private readonly snapshotDir: string;
  private readonly collectionName: string;
  private readonly codebasePath: string;
  private readonly shardCount: number;

  private readonly oldSnapshotPath: string;
  private readonly newSnapshotDir: string;
  private readonly backupPath: string;

  constructor(snapshotDir: string, collectionName: string, codebasePath: string, shardCount = 4) {
    this.snapshotDir = snapshotDir;
    this.collectionName = collectionName;
    this.codebasePath = codebasePath;
    this.shardCount = shardCount;

    this.oldSnapshotPath = join(snapshotDir, `${collectionName}.json`);
    this.newSnapshotDir = join(snapshotDir, collectionName);
    this.backupPath = join(snapshotDir, `${collectionName}.json.backup`);
  }

  /**
   * Check if migration is needed
   */
  async needsMigration(): Promise<boolean> {
    // Check if old format exists
    const oldExists = await this.fileExists(this.oldSnapshotPath);
    if (!oldExists) {
      return false;
    }

    // Check if new format already exists
    const newExists = await this.fileExists(join(this.newSnapshotDir, "meta.json"));
    if (newExists) {
      return false;
    }

    return true;
  }

  /**
   * Migrate old snapshot to new format
   */
  async migrate(): Promise<MigrationResult> {
    // Check if migration is needed
    if (!(await this.needsMigration())) {
      // Check if already migrated or no snapshot exists
      const newExists = await this.fileExists(join(this.newSnapshotDir, "meta.json"));
      return {
        success: true,
        filesCount: 0,
        skippedCount: 0,
        alreadyMigrated: newExists || !(await this.fileExists(this.oldSnapshotPath)),
      };
    }

    try {
      // Read old snapshot
      const oldContent = await fs.readFile(this.oldSnapshotPath, "utf-8");
      const oldSnapshot = JSON.parse(oldContent) as OldSnapshot;

      // Create backup
      await fs.copyFile(this.oldSnapshotPath, this.backupPath);

      // Build file metadata
      const files = new Map<string, FileMetadata>();
      let skippedCount = 0;

      if (oldSnapshot.fileMetadata) {
        // v2 format - has metadata
        for (const [path, metadata] of Object.entries(oldSnapshot.fileMetadata)) {
          // Check if file still exists
          const absolutePath = join(this.codebasePath, path);
          if (await this.fileExists(absolutePath)) {
            files.set(path, metadata);
          } else {
            skippedCount++;
          }
        }
      } else {
        // v1 format - need to get metadata from filesystem
        for (const [path, hash] of Object.entries(oldSnapshot.fileHashes)) {
          const absolutePath = join(this.codebasePath, path);
          const stats = await this.getFileStats(absolutePath);

          if (stats) {
            files.set(path, {
              mtime: stats.mtimeMs,
              size: stats.size,
              hash,
            });
          } else {
            skippedCount++;
          }
        }
      }

      // Write new sharded format
      const manager = new ShardedSnapshotManager(this.snapshotDir, this.collectionName, this.shardCount);

      await manager.save(oldSnapshot.codebasePath, files);

      // Delete old file (backup remains)
      await fs.unlink(this.oldSnapshotPath);

      return {
        success: true,
        filesCount: files.size,
        skippedCount,
        alreadyMigrated: false,
      };
    } catch (error) {
      return {
        success: false,
        filesCount: 0,
        skippedCount: 0,
        alreadyMigrated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Ensure snapshot is migrated (auto-migrate if needed)
   */
  async ensureMigrated(): Promise<void> {
    if (await this.needsMigration()) {
      const result = await this.migrate();
      if (!result.success) {
        throw new Error(`Migration failed: ${result.error}`);
      }
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get file stats safely
   */
  private async getFileStats(path: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const stats = await fs.stat(path);
      return { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      return null;
    }
  }
}
