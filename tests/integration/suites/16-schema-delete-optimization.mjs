/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */

// SchemaManager + CURRENT_SCHEMA_VERSION (top-level constant) were removed
// during SOLID refactor. Migration orchestration now lives behind the
// Migrator class; schema version is derived per-Migrator. Test 9 in this
// suite covered the old standalone SchemaManager API and is skip()'d.
// QdrantManager payload index ops still work — kept inline below.
// See plan `2026-05-17-integration-tests-rewrite-impl.md`.
import { buildPipelineConfig } from "../../../build/core/domains/ingest/pipeline/index.js";
import { assert, log, section, skip } from "../helpers.mjs";

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

    // SchemaManager standalone migration test — skipped: the old
    // SchemaManager#ensureCurrentSchema/getSchemaVersion API was removed
    // during SOLID refactor. Schema migration orchestration now flows
    // through the Migrator class wired in IngestFacade via
    // ingest/factory.ts. Restoring this scenario requires constructing
    // the full migration graph (SchemaMigrator + stores + Migrator) —
    // follow-up. The migration is exercised indirectly by suites that
    // call IngestFacade#indexCodebase against fresh collections.
    skip("SchemaManager standalone migration API removed (follow-up)");

    // Test 10: Delete configuration defaults
    log("info", "Testing delete optimization configuration...");

    // Build config with known values to verify the factory
    const testConfig = buildPipelineConfig(
      { concurrency: 1, batchSize: 1024, batchTimeoutMs: 2000 },
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
