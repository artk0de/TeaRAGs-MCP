import { promises as fs } from "node:fs";
import { join } from "node:path";

import { isDebug } from "../pipeline/infra/runtime.js";

/**
 * Cleans up stale snapshot artifacts for a specific collection.
 *
 * Targets: checkpoints, legacy v1/v2 snapshots, migration backups.
 * Does NOT touch v3 sharded snapshot directories.
 */
export class SnapshotCleaner {
  private readonly snapshotDir: string;
  private readonly collectionName: string;

  constructor(snapshotDir: string, collectionName: string) {
    this.snapshotDir = snapshotDir;
    this.collectionName = collectionName;
  }

  /**
   * Remove stale artifacts after indexing completes (success or failure).
   * Safe to call multiple times (idempotent).
   */
  async cleanupAfterIndexing(): Promise<void> {
    const artifacts = [
      `${this.collectionName}.checkpoint.json`,
      `${this.collectionName}.checkpoint.json.tmp`,
      `${this.collectionName}.json`,
      `${this.collectionName}.json.backup`,
    ];

    const removed: string[] = [];

    for (const artifact of artifacts) {
      const path = join(this.snapshotDir, artifact);
      try {
        await fs.unlink(path);
        removed.push(artifact);
      } catch {
        // File doesn't exist — expected for most runs
      }
    }

    if (removed.length > 0 && isDebug()) {
      const labels = removed.map((a) => a.replace(`${this.collectionName}.`, "").replace(".json", ""));
      console.error(`[Cleanup] Removed ${removed.length} artifact(s) for ${this.collectionName}: ${labels.join(", ")}`);
    }
  }
}
