/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */

// The standalone SchemaManager#ensureCurrentSchema / getSchemaVersion API is
// gone: an existing collection's schema is upgraded by the Migrator sweep
// IngestFacade#reindexChanges runs, and a new collection is stamped at the
// latest version by SchemaManager#initializeSchema. The schema scenario below
// drives the first through the facade and checks it against the second.
// QdrantManager payload index ops still work — kept inline below.
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { SchemaMetadataPointStore } from "../../../build/core/adapters/qdrant/schema-metadata-point.js";
import { createIngestDependencies } from "../../../build/core/api/internal/ingest-dependencies.js";
import { buildPipelineConfig } from "../../../build/core/domains/ingest/pipeline/index.js";
import { ParallelFileSynchronizer } from "../../../build/core/domains/ingest/sync/parallel-synchronizer.js";
import { StaticPayloadBuilder } from "../../../build/core/domains/trajectory/static/provider.js";
import { TEST_DIR } from "../config.mjs";
import {
  assert,
  createProbeOnlyEmbeddings,
  createTestFacades,
  createTestFile,
  log,
  resources,
  section,
  seedLegacyIndexedCollection,
} from "../helpers.mjs";

export async function testSchemaAndDeleteOptimization(qdrant) {
  section("15. Schema Migration & Delete Optimization");

  // Test 9: SchemaManager and payload index migration
  log("info", "Testing SchemaManager and payload index...");

  const schemaTestCollection = `test_schema_${Date.now()}`;

  // Create collection first
  await qdrant.createCollection(schemaTestCollection, 5, "Cosine", false);

  try {
    // Test hasPayloadIndex (should be false for new collection)
    const indexExistsBefore = await qdrant.hasPayloadIndex(schemaTestCollection, "relativePath");
    assert(indexExistsBefore === false, "New collection has no relativePath index");

    // Test createPayloadIndex
    await qdrant.createPayloadIndex(schemaTestCollection, "relativePath", "keyword");

    // Verify index was created
    const indexExistsAfter = await qdrant.hasPayloadIndex(schemaTestCollection, "relativePath");
    assert(indexExistsAfter === true, "Index created successfully");

    // Test ensurePayloadIndex (should not recreate)
    const created = await qdrant.ensurePayloadIndex(schemaTestCollection, "relativePath", "keyword");
    assert(created === false, "ensurePayloadIndex returns false when index exists");

    await testSchemaMigrationFromZero(qdrant);

    // Test 10: Delete configuration defaults
    log("info", "Testing delete optimization configuration...");

    // buildPipelineConfig signature post-SOLID: (pipelineConcurrency, embeddingTune, qdrantTune).
    // Embedding tune carries upsert batch / flush / ordering; qdrantTune carries delete
    // batch / concurrency / flush. The split mirrors src/bootstrap/config so the same
    // factory is reused in production wiring.
    const testConfig = buildPipelineConfig(
      1, // pipelineConcurrency
      { batchSize: 1024, upsertBatchSize: 1024, upsertFlushIntervalMs: 2000, upsertOrdering: "weak" },
      { deleteConcurrency: 8, deleteBatchSize: 500, deleteFlushTimeoutMs: 1000 },
    );

    // Check config has separate delete worker pool
    assert(testConfig.deleteWorkerPool !== undefined, "Config has deleteWorkerPool");
    assert(
      testConfig.deleteWorkerPool.concurrency >= 8,
      `Delete concurrency is high (${testConfig.deleteWorkerPool.concurrency})`,
    );
    assert(
      testConfig.deleteAccumulator.batchSize >= 500,
      `Delete batch size is large (${testConfig.deleteAccumulator.batchSize})`,
    );

    // Verify upsert and delete have independent settings
    assert(
      testConfig.workerPool.concurrency !== testConfig.deleteWorkerPool.concurrency ||
        testConfig.upsertAccumulator.batchSize !== testConfig.deleteAccumulator.batchSize,
      "Upsert and delete have different settings",
    );

    log("pass", "Schema migration and delete optimization verified");
  } finally {
    await qdrant.deleteCollection(schemaTestCollection);
  }
}

/**
 * A collection indexed before schema versioning (no schema metadata point, no
 * payload indexes) is migrated 0 → latest by the next incremental reindex. The
 * result must be indistinguishable from a collection created today: same
 * stamped schema version, same payload index set — the initializeSchema ⟺
 * migrations parity `SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS` documents, checked here
 * against a real Qdrant instead of the unit suite's mock.
 */
async function testSchemaMigrationFromZero(qdrant) {
  log("info", "Testing schema migration 0 → latest via IngestFacade#reindexChanges...");

  const codebase = join(TEST_DIR, "schema_migration");
  const snapshotDir = join(TEST_DIR, "schema_migration_snapshots");
  await fs.mkdir(join(codebase, "src"), { recursive: true });
  await fs.mkdir(snapshotDir, { recursive: true });
  resources.trackSnapshotDir(snapshotDir);
  const sourceFile = await createTestFile(codebase, "src/a.ts", "export const a = 1;\n");

  const embeddings = createProbeOnlyEmbeddings();
  const collectionName = await seedLegacyIndexedCollection(qdrant, embeddings, codebase);
  // The snapshot matches disk, so the reindex runs the migration sweep and
  // finds nothing to embed.
  await new ParallelFileSynchronizer(codebase, collectionName, snapshotDir, 4).updateSnapshot([sourceFile]);

  const metadataPoint = new SchemaMetadataPointStore(qdrant);
  assert((await metadataPoint.read(collectionName)) === null, "Legacy collection has no schema metadata point");
  assert(
    (await qdrant.listPayloadIndexes(collectionName)).length === 0,
    "Legacy collection has no payload indexes (schema version reads as 0)",
  );

  // Reference: a collection created today, through the same factory
  // IngestFacade hands its indexing pipeline for new collections.
  const freshCollection = `test_schema_fresh_${Date.now()}`;
  await qdrant.createCollection(freshCollection, embeddings.getDimensions(), "Cosine", false);
  resources.trackCollection(freshCollection);
  await createIngestDependencies(qdrant, snapshotDir, new StaticPayloadBuilder())
    .createSchemaManager(freshCollection)
    .initializeSchema(freshCollection);
  const freshVersion = (await metadataPoint.read(freshCollection))?.schemaVersion;

  const { ingest } = createTestFacades(qdrant, embeddings, { snapshotDir });
  const stats = await ingest.reindexChanges(codebase);
  assert(
    stats.status === "completed" && stats.filesAdded + stats.filesModified + stats.filesDeleted === 0,
    `Reindex ran the migration sweep with no file changes: ${stats.status}, +${stats.filesAdded} ~${stats.filesModified} -${stats.filesDeleted}`,
  );

  const migratedVersion = (await metadataPoint.read(collectionName))?.schemaVersion;
  assert(
    typeof freshVersion === "number" && freshVersion > 0 && migratedVersion === freshVersion,
    `Migrated collection stamped at the latest schema version: ${migratedVersion} (new collection: ${freshVersion})`,
  );

  const indexSignature = async (collection) =>
    (await qdrant.listPayloadIndexes(collection)).map(({ field, dataType }) => `${field}:${dataType}`).sort();
  const migratedIndexes = await indexSignature(collectionName);
  const freshIndexes = await indexSignature(freshCollection);
  const missing = freshIndexes.filter((index) => !migratedIndexes.includes(index));
  const extra = migratedIndexes.filter((index) => !freshIndexes.includes(index));
  assert(
    migratedIndexes.length > 0 && missing.length === 0 && extra.length === 0,
    `Migrated payload indexes equal a new collection's (${migratedIndexes.length}): missing [${missing.join(", ")}], extra [${extra.join(", ")}]`,
  );
}
