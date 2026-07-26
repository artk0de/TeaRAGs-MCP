/**
 * IngestDependencies — DI container for ingest pipeline collaborators.
 *
 * Replaces direct `new` of SchemaManager, ParallelFileSynchronizer, and
 * SnapshotMigrator inside orchestrators, enabling testability and
 * adherence to the Dependency Inversion Principle.
 *
 * Only the CONTRACT lives here. The concrete wiring moved to
 * `api/internal/ingest-dependencies.ts`: it assembles the migration pipelines,
 * which now live in the maintenance domain, and ingest may not import a sibling
 * domain — `createMigrator` therefore hands back a `MigratorPort`.
 */

import type { SchemaManager } from "../../adapters/qdrant/schema-manager.js";
import type { MigratorPort } from "../../contracts/types/migration.js";
import type { PayloadBuilder } from "../../contracts/types/provider.js";

import type { ParallelFileSynchronizer } from "./sync/parallel-synchronizer.js";

// ── Public interfaces ────────────────────────────────────────────

export interface SynchronizerTuning {
  concurrency?: number;
  ioConcurrency?: number;
}

export interface IngestDependencies {
  createSchemaManager: (collectionName: string) => SchemaManager;
  createSynchronizer: (codebasePath: string, collectionName: string) => ParallelFileSynchronizer;
  createMigrator: (collectionName: string, codebasePath: string) => MigratorPort;
  payloadBuilder: PayloadBuilder;
  snapshotDir: string;
}
