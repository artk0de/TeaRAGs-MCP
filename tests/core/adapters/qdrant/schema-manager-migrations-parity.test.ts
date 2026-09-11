import { describe, expect, it } from "vitest";

import { SchemaManager } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaMigrator } from "../../../../src/core/domains/maintenance/migration/schema-migrator.js";
import type { IndexStore } from "../../../../src/core/domains/maintenance/migration/types.js";

type IndexKey = `${string}:${string}`;

function recordingIndexStore(seen: Set<IndexKey>): IndexStore {
  return {
    getSchemaVersion: async () => 0,
    ensureIndex: async (_c, field, type) => {
      seen.add(`${field}:${type}`);
      return true;
    },
    storeSchemaVersion: async () => undefined,
    hasPayloadIndex: async () => false,
    getCollectionInfo: async () => ({ hybridEnabled: true, vectorSize: 8 }),
    updateSparseConfig: async () => undefined,
    deletePointsByFilter: async () => undefined,
    scrollAllPayload: async () => [],
    batchSetPayload: async () => undefined,
    deletePayloadKeys: async () => undefined,
  };
}

/**
 * A fresh collection is stamped at LATEST_SCHEMA_VERSION, so every schema
 * migration is filtered out as already applied. Any index `initializeSchema`
 * forgets therefore never appears on a force-rebuilt collection (taxdome `_v13`:
 * schemaVersion 13, zero enrichedAt indexes). The two paths must create the
 * same index set.
 */
describe("initializeSchema ⟺ schema migrations parity", () => {
  it("creates exactly the indexes the migrations would", async () => {
    const fromInit = new Set<IndexKey>();
    const fakeQdrant = {
      createPayloadIndex: async (_c: string, field: string, schema: string) => {
        fromInit.add(`${field}:${schema}`);
      },
      getCollectionInfo: async () => ({ vectorSize: 8, hybridEnabled: true }),
      addPoints: async () => undefined,
      addPointsWithSparse: async () => undefined,
    };
    await new SchemaManager(fakeQdrant as never).initializeSchema("c");

    const fromMigrations = new Set<IndexKey>();
    const migrator = new SchemaMigrator("c", recordingIndexStore(fromMigrations), { enableHybrid: true });
    for (const migration of migrator.getMigrations()) await migration.apply();

    expect([...fromInit].sort()).toEqual([...fromMigrations].sort());
  });
});
