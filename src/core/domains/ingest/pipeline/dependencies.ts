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
 *
 * It lives in `pipeline/` beside its consumer `BaseIndexingPipeline`, not at
 * the ingest root: the root is the domain's stable sink and may not import
 * back into `sync/` or `pipeline/chunker/` (bd tea-rags-mcp-g7w8f G2).
 */

import type { SchemaManager } from "../../../adapters/qdrant/schema-manager.js";
import type { MigratorPort } from "../../../contracts/types/migration.js";
import type { PayloadBuilder } from "../../../contracts/types/provider.js";
import type { ParallelFileSynchronizer } from "../sync/index.js";
import type { ChunkerPoolFactory } from "./chunker/infra/pool.js";

// ── Public interfaces ────────────────────────────────────────────

export interface IngestDependencies {
  createSchemaManager: (collectionName: string) => SchemaManager;
  createSynchronizer: (codebasePath: string, collectionName: string) => ParallelFileSynchronizer;
  createMigrator: (collectionName: string, codebasePath: string) => MigratorPort;
  /**
   * Builds each run's chunker pool. Optional: absent → `BaseIndexingPipeline`
   * forks a fresh `ChunkerPool` per run, which is what production does. Tests
   * inject a factory that leases warm pools (bd tea-rags-mcp-bbo1h.1).
   */
  createChunkerPool?: ChunkerPoolFactory;
  payloadBuilder: PayloadBuilder;
  snapshotDir: string;
}
