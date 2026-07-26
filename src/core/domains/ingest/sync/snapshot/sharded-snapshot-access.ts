/**
 * Adapts `ShardedSnapshotManager` to the migration-side access port.
 *
 * The snapshot migration steps live in the maintenance domain and may not
 * import ingest, but the on-disk sharded format is ingest's. The composition
 * root injects this factory so the migration reads and rewrites snapshots
 * through a two-method view instead of the concrete manager.
 */

import type { ShardedSnapshotAccess, ShardedSnapshotAccessFactory } from "../../../../contracts/types/migration.js";

import { ShardedSnapshotManager } from "./sharded-snapshot.js";

export const createShardedSnapshotAccess: ShardedSnapshotAccessFactory = (
  snapshotDir,
  collectionName,
  shardCount,
): ShardedSnapshotAccess => {
  const manager = new ShardedSnapshotManager(snapshotDir, collectionName, shardCount);
  return {
    save: async (codebasePath, files) => manager.save(codebasePath, files),
    load: async () => {
      const snapshot = await manager.load();
      return snapshot === null ? null : { codebasePath: snapshot.codebasePath, files: snapshot.files };
    },
  };
};
