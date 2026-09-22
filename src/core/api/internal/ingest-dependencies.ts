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
import { toPhysicalPayloadKey } from "../../contracts/signal-utils.js";
import type { PayloadBuilder } from "../../contracts/types/provider.js";
import type { IngestDependencies, SynchronizerTuning } from "../../domains/ingest/factory.js";
import { computeCollectionStats } from "../../domains/ingest/infra/collection-stats.js";
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
import { fullRegistryPayloadSignalDescriptors, fullRegistryStatsAccumulators } from "./composition.js";

export function createIngestDependencies(
  qdrant: QdrantManager,
  snapshotDir: string,
  payloadBuilder: PayloadBuilder,
  syncTuning?: SynchronizerTuning,
  enableHybrid = false,
  providerKey?: string,
  gitTimePeriods?: { fileMonths: number; chunkMonths: number },
): IngestDependencies {
  // The full registry, not this process's composition, for both the payload
  // keys and the stats recompute below.
  const fullRegistrySignals = fullRegistryPayloadSignalDescriptors();

  // What a stored payload index is judged against by schema-v16: the physical
  // key of every payload signal the FULL registry declares, whatever this
  // process's trajectory flags are (bd tea-rags-mcp-q34ic). Both SchemaMigrator
  // constructions below take it, so the version a new collection is stamped at
  // and the migrations an existing one runs agree.
  const declaredPayloadKeys: ReadonlySet<string> = new Set(
    fullRegistrySignals.map((descriptor) => toPhysicalPayloadKey(descriptor.key)),
  );

  return {
    createSchemaManager: (collectionName: string) => {
      const indexStore = new IndexStoreAdapter(qdrant);
      const sparseStore = new SparseStoreAdapter(qdrant);
      const enrichmentStore = providerKey ? new EnrichmentStoreAdapter(qdrant) : undefined;
      const schemaMigrator = new SchemaMigrator(
        collectionName,
        indexStore,
        { enableHybrid, providerKey, declaredPayloadKeys },
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
      //
      // The recompute reads the FULL registry rather than this process's
      // composition, for the same reason `declaredPayloadKeys` does: the values
      // live in the payload, so a codegraph-off process recomputing a
      // codegraph-enriched index must still produce codegraph percentiles
      // instead of quietly dropping them.
      const statsStore = new StatsStoreAdapter(
        qdrant,
        new StatsCache(snapshotDir),
        undefined,
        undefined,
        (points) =>
          computeCollectionStats(points, fullRegistrySignals, fullRegistryStatsAccumulators(), gitTimePeriods),
        fullRegistrySignals,
      );

      return new Migrator({
        snapshot: new SnapshotMigrator(snapshotStore),
        schema: new SchemaMigrator(
          collectionName,
          indexStore,
          { enableHybrid, providerKey, declaredPayloadKeys },
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
