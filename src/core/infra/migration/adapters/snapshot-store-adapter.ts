/**
 * SnapshotStoreAdapter — adapts filesystem snapshot operations to SnapshotStore interface.
 *
 * Detects snapshot format from disk and provides read/write/backup/delete
 * operations needed by snapshot migration steps.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { ShardedSnapshotManager } from "../../../domains/ingest/sync/sharded-snapshot.js";
import type { SnapshotStore } from "../types.js";

interface OldSnapshotV1 {
  codebasePath: string;
  fileHashes: Record<string, string>;
}

interface OldSnapshotV2 {
  version: "2";
  codebasePath: string;
  fileMetadata: Record<string, { mtime: number; size: number; hash: string }>;
}

export class SnapshotStoreAdapter implements SnapshotStore {
  private readonly oldSnapshotPath: string;
  private readonly shardedMetaPath: string;
  private readonly backupPath: string;

  constructor(
    private readonly snapshotDir: string,
    private readonly collectionName: string,
    private readonly shardCount = 4,
  ) {
    this.oldSnapshotPath = join(snapshotDir, `${collectionName}.json`);
    this.shardedMetaPath = join(snapshotDir, collectionName, "meta.json");
    this.backupPath = join(snapshotDir, `${collectionName}.json.backup`);
  }

  async getFormat(): Promise<"v1" | "v2" | "sharded" | "none"> {
    // Sharded takes priority — if meta.json exists, we're already migrated
    if (await this.exists(this.shardedMetaPath)) {
      return "sharded";
    }

    if (!(await this.exists(this.oldSnapshotPath))) {
      return "none";
    }

    // Read old file to detect version
    try {
      const raw = await fs.readFile(this.oldSnapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      return parsed.version === "2" ? "v2" : "v1";
    } catch {
      return "none";
    }
  }

  async readV1(): Promise<{ fileHashes: Record<string, string>; codebasePath: string } | null> {
    const format = await this.getFormat();
    if (format !== "v1") return null;

    try {
      const raw = await fs.readFile(this.oldSnapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as OldSnapshotV1;
      return { fileHashes: parsed.fileHashes, codebasePath: parsed.codebasePath };
    } catch {
      return null;
    }
  }

  async readV2(): Promise<{
    fileMetadata: Record<string, { mtime: number; size: number; hash: string }>;
    codebasePath: string;
  } | null> {
    const format = await this.getFormat();
    if (format !== "v2") return null;

    try {
      const raw = await fs.readFile(this.oldSnapshotPath, "utf-8");
      const parsed = JSON.parse(raw) as OldSnapshotV2;
      return { fileMetadata: parsed.fileMetadata, codebasePath: parsed.codebasePath };
    } catch {
      return null;
    }
  }

  async writeSharded(
    codebasePath: string,
    files: Map<string, { mtime: number; size: number; hash: string }>,
  ): Promise<void> {
    const manager = new ShardedSnapshotManager(this.snapshotDir, this.collectionName, this.shardCount);
    await manager.save(codebasePath, files);
  }

  async backup(): Promise<void> {
    if (await this.exists(this.oldSnapshotPath)) {
      await fs.copyFile(this.oldSnapshotPath, this.backupPath);
    }
  }

  async deleteOld(): Promise<void> {
    if (await this.exists(this.oldSnapshotPath)) {
      await fs.unlink(this.oldSnapshotPath);
    }
  }

  async statFile(absolutePath: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const stat = await fs.stat(absolutePath);
      return { mtimeMs: stat.mtimeMs, size: stat.size };
    } catch {
      return null;
    }
  }

  async invalidateByExtensions(extensions: string[]): Promise<number> {
    const format = await this.getFormat();
    if (format !== "sharded") return 0;

    const snapshotManager = new ShardedSnapshotManager(this.snapshotDir, this.collectionName, this.shardCount);
    const snapshot = await snapshotManager.load();
    if (!snapshot) return 0;

    const extSet = new Set(extensions);
    let invalidated = 0;

    for (const [path, meta] of snapshot.files) {
      const ext = path.lastIndexOf(".") >= 0 ? path.slice(path.lastIndexOf(".")) : "";
      if (extSet.has(ext)) {
        meta.hash = ""; // Empty hash → synchronizer detects mismatch → "modified"
        invalidated++;
      }
    }

    if (invalidated > 0) {
      await snapshotManager.save(snapshot.codebasePath, snapshot.files);
    }

    return invalidated;
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }
}
