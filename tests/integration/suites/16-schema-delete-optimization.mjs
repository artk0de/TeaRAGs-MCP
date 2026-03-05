/**
 * Integration Test Suite
 * Auto-migrated from test-business-logic.mjs
 */

import { buildPipelineConfig } from "../../../build/code/pipeline/index.js";
import { CURRENT_SCHEMA_VERSION, SchemaManager } from "../../../build/code/schema-migration.js";
import { assert, log, section } from "../helpers.mjs";

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

    // Test SchemaManager
    const schemaManager = new SchemaManager(qdrant);

    // Create a new collection without index
    const schemaTestCollection2 = `test_schema2_${Date.now()}`;
    await qdrant.createCollection(schemaTestCollection2, 5, "Cosine", false);

    try {
      // Get schema version (should be 0 for new collection without index)
      const versionBefore = await schemaManager.getSchemaVersion(schemaTestCollection2);
      assert(versionBefore === 0, `New collection has schema version 0: ${versionBefore}`);

      // Ensure current schema (should migrate to v4)
      const migrationResult = await schemaManager.ensureCurrentSchema(schemaTestCollection2);
      assert(migrationResult.success === true, "Migration successful");
      assert(migrationResult.fromVersion === 0, "Migrated from v0");
      assert(migrationResult.toVersion === CURRENT_SCHEMA_VERSION, `Migrated to v${CURRENT_SCHEMA_VERSION}`);
      assert(migrationResult.migrationsApplied.length > 0, "At least one migration applied");

      // Verify index was created during migration
      const indexExistsPostMigration = await qdrant.hasPayloadIndex(schemaTestCollection2, "relativePath");
      assert(indexExistsPostMigration === true, "Index created during migration");

      // Verify schema version is now current
      const versionAfter = await schemaManager.getSchemaVersion(schemaTestCollection2);
      assert(
        versionAfter === CURRENT_SCHEMA_VERSION,
        `Schema version is now ${CURRENT_SCHEMA_VERSION}: ${versionAfter}`,
      );

      // Run migration again (should skip)
      const migrationResult2 = await schemaManager.ensureCurrentSchema(schemaTestCollection2);
      assert(migrationResult2.success === true, "Second migration call successful");
      assert(migrationResult2.migrationsApplied.length === 0, "No migrations needed on second call");
    } finally {
      await qdrant.deleteCollection(schemaTestCollection2);
    }

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
