import { SnapshotV2MtimeSize } from "./snapshot_migrations/snapshot-v2-mtime-size.js";
import { SnapshotV3Sharded } from "./snapshot_migrations/snapshot-v3-sharded.js";
import type { Migration, MigrationRunner, SnapshotStore } from "./types.js";

const FORMAT_VERSION: Record<"none" | "v1" | "v2" | "sharded", number> = {
  none: 0,
  v1: 1,
  v2: 2,
  sharded: 3,
};

/**
 * MigrationRunner for snapshot format upgrades.
 *
 * Version is implicit in the snapshot format — setVersion is a no-op.
 * Registered migrations: v1→v2 (version 2), v2→sharded (version 3).
 */
export class SnapshotMigrator implements MigrationRunner {
  private readonly migrations: Migration[];

  /** Latest snapshot version — computed from registered migrations. */
  readonly latestVersion: number;

  constructor(private readonly store: SnapshotStore) {
    this.migrations = [new SnapshotV2MtimeSize(store), new SnapshotV3Sharded(store)];
    this.latestVersion = Math.max(...this.migrations.map((m) => m.version));
  }

  async getVersion(): Promise<number> {
    const format = await this.store.getFormat();
    return FORMAT_VERSION[format];
  }

  async setVersion(_version: number): Promise<void> {
    // Version is implicit in the snapshot format written by migrations.
    // No explicit version record to update.
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
