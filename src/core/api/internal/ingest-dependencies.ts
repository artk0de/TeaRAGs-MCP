/**
 * Assembles the ingest pipeline's collaborators.
 *
 * Lives in `api/internal` because it is composition work across three modules
 * that may not import each other: the Qdrant schema manager (adapters), the
 * file synchronizer and sharded-snapshot format (ingest), and the migration
 * pipelines (maintenance). The ingest domain declares the `IngestDependencies`
 * contract; this is the only place that knows every concrete.
 */

import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { SchemaManager } from "../../adapters/qdrant/schema-manager.js";
import type { PayloadBuilder } from "../../contracts/types/provider.js";
import type { IngestDependencies, SynchronizerTuning } from "../../domains/ingest/factory.js";
import { ParallelFileSynchronizer } from "../../domains/ingest/sync/parallel-synchronizer.js";
import { createShardedSnapshotAccess } from "../../domains/ingest/sync/snapshot/sharded-snapshot-access.js";
import { EnrichmentStoreAdapter } from "../../domains/maintenance/migration/adapters/enrichment-store-adapter.js";
import { IndexStoreAdapter } from "../../domains/maintenance/migration/adapters/index-store-adapter.js";
import { SnapshotStoreAdapter } from "../../domains/maintenance/migration/adapters/snapshot-store-adapter.js";
import { SparseStoreAdapter } from "../../domains/maintenance/migration/adapters/sparse-store-adapter.js";
import { StatsStoreAdapter } from "../../domains/maintenance/migration/adapters/stats-store-adapter.js";
import { Migrator } from "../../domains/maintenance/migration/migrator.js";
import { SchemaMigrator } from "../../domains/maintenance/migration/schema-migrator.js";
import { SnapshotMigrator } from "../../domains/maintenance/migration/snapshot-migrator.js";
import { SparseMigrator } from "../../domains/maintenance/migration/sparse-migrator.js";
import { StatsMigrator } from "../../domains/maintenance/migration/stats-migrator.js";
import { StatsCache } from "../../infra/stats-cache.js";

export function createIngestDependencies(
  qdrant: QdrantManager,
  snapshotDir: string,
  payloadBuilder: PayloadBuilder,
  syncTuning?: SynchronizerTuning,
  enableHybrid = false,
  providerKey?: string,
): IngestDependencies {
  return {
    createSchemaManager: (collectionName: string) => {
      const indexStore = new IndexStoreAdapter(qdrant);
      const sparseStore = new SparseStoreAdapter(qdrant);
      const enrichmentStore = providerKey ? new EnrichmentStoreAdapter(qdrant) : undefined;
      const schemaMigrator = new SchemaMigrator(
        collectionName,
        indexStore,
        { enableHybrid, providerKey },
        enrichmentStore,
      );
      const sparseMigrator = new SparseMigrator(collectionName, sparseStore, enableHybrid);
      return new SchemaManager(qdrant, schemaMigrator.latestVersion, sparseMigrator.latestVersion);
    },
    createSynchronizer: (codebasePath, collectionName) =>
      new ParallelFileSynchronizer(
        codebasePath,
        collectionName,
        snapshotDir,
        syncTuning?.concurrency,
        syncTuning?.ioConcurrency,
      ),
    createMigrator: (collectionName, _codebasePath) => {
      const snapshotStore = new SnapshotStoreAdapter(snapshotDir, collectionName, createShardedSnapshotAccess);
      const indexStore = new IndexStoreAdapter(qdrant);
      const sparseStore = new SparseStoreAdapter(qdrant);
      const enrichmentStore = providerKey ? new EnrichmentStoreAdapter(qdrant) : undefined;
      // StatsCache is a path wrapper with no state of its own, and the stats
      // files live under the same directory as the snapshots — so constructing
      // one here reads exactly what the indexing path writes.
      const statsStore = new StatsStoreAdapter(qdrant, new StatsCache(snapshotDir));

      return new Migrator({
        snapshot: new SnapshotMigrator(snapshotStore),
        schema: new SchemaMigrator(
          collectionName,
          indexStore,
          { enableHybrid, providerKey },
          enrichmentStore,
          snapshotStore,
        ),
        sparse: new SparseMigrator(collectionName, sparseStore, enableHybrid),
        stats: new StatsMigrator(collectionName, statsStore),
      });
    },
    payloadBuilder,
    snapshotDir,
  };
}
