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
import { SnapshotMigrator } from "./sync/migration.js";
import { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";

// ── Public interfaces ────────────────────────────────────────────

export interface SynchronizerTuning {
  concurrency?: number;
  ioConcurrency?: number;
}

export interface IngestDependencies {
  createSchemaManager: () => SchemaManager;
  createSynchronizer: (codebasePath: string, collectionName: string) => ParallelFileSynchronizer;
  createMigrator: (collectionName: string, codebasePath: string) => SnapshotMigrator;
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
    createMigrator: (collectionName, codebasePath) => new SnapshotMigrator(snapshotDir, collectionName, codebasePath),
    payloadBuilder,
    snapshotDir,
  };
}
