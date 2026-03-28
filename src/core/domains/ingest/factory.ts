/**
 * IngestDependencies — DI container for ingest pipeline collaborators.
 *
 * Replaces direct `new` of SchemaManager, ParallelFileSynchronizer, and
 * SnapshotMigrator inside orchestrators, enabling testability and
 * adherence to the Dependency Inversion Principle.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { SchemaManager } from "../../adapters/qdrant/schema-migration.js";
import type { PayloadBuilder } from "../../contracts/types/provider.js";
import { IndexStoreAdapter } from "../../infra/migration/adapters/index-store-adapter.js";
import { SnapshotStoreAdapter } from "../../infra/migration/adapters/snapshot-store-adapter.js";
import { SparseStoreAdapter } from "../../infra/migration/adapters/sparse-store-adapter.js";
import { Migrator } from "../../infra/migration/migrator.js";
import { SchemaMigrator } from "../../infra/migration/schema-migrator.js";
import { SnapshotMigrator } from "../../infra/migration/snapshot-migrator.js";
import { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";

// ── Public interfaces ────────────────────────────────────────────

export interface SynchronizerTuning {
  concurrency?: number;
  ioConcurrency?: number;
}

export interface IngestDependencies {
  createSchemaManager: () => SchemaManager;
  createSynchronizer: (codebasePath: string, collectionName: string) => ParallelFileSynchronizer;
  createMigrator: (collectionName: string, codebasePath: string) => Migrator;
  payloadBuilder: PayloadBuilder;
  snapshotDir: string;
}

// ── Default factory ──────────────────────────────────────────────

export function createIngestDependencies(
  qdrant: QdrantManager,
  snapshotDir: string,
  payloadBuilder: PayloadBuilder,
  syncTuning?: SynchronizerTuning,
  enableHybrid = false,
): IngestDependencies {
  return {
    createSchemaManager: () => new SchemaManager(qdrant, enableHybrid),
    createSynchronizer: (codebasePath, collectionName) =>
      new ParallelFileSynchronizer(
        codebasePath,
        collectionName,
        snapshotDir,
        syncTuning?.concurrency,
        syncTuning?.ioConcurrency,
      ),
    createMigrator: (collectionName, _codebasePath) => {
      const snapshotStore = new SnapshotStoreAdapter(snapshotDir, collectionName);
      const indexStore = new IndexStoreAdapter(qdrant);
      const sparseStore = new SparseStoreAdapter(qdrant);

      return new Migrator({
        snapshot: new SnapshotMigrator(snapshotStore),
        schema: new SchemaMigrator(collectionName, indexStore, sparseStore, { enableHybrid }),
      });
    },
    payloadBuilder,
    snapshotDir,
  };
}
