import { describe, expect, it } from "vitest";

import { SchemaManager } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaMigrator } from "../../../../src/core/domains/maintenance/migration/schema-migrator.js";
import type { EnrichmentStore, IndexStore } from "../../../../src/core/domains/maintenance/migration/types.js";

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
    listPayloadIndexes: async () => [],
    dropPayloadIndex: async () => undefined,
  };
}

function stubEnrichmentStore(): EnrichmentStore {
  return {
    isMigrated: async () => false,
    scrollAllChunks: async () => [],
    batchSetPayload: async () => undefined,
    markMigrated: async () => undefined,
  };
}

/**
 * Run one migrator end to end and report every index it ensured. Passing an
 * enrichment store changes WHICH migrations exist: the runner drops the
 * enrichment-gated ones (SchemaV9 today) when it has no store and no provider
 * key, so a single construction never sees the whole set. The declared payload
 * keys gate v16 and every migration above it; production always supplies them.
 */
async function indexesFromMigrations(
  enrichmentStore?: EnrichmentStore,
  declaredPayloadKeys?: ReadonlySet<string>,
): Promise<Set<IndexKey>> {
  const seen = new Set<IndexKey>();
  const migrator = new SchemaMigrator(
    "c",
    recordingIndexStore(seen),
    { enableHybrid: true, ...(enrichmentStore && { providerKey: "git" }), declaredPayloadKeys },
    enrichmentStore,
  );
  for (const migration of migrator.getMigrations()) await migration.apply();
  return seen;
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
    await new SchemaManager(fakeQdrant as never, 0).initializeSchema("c");

    const fromMigrations = new Set<IndexKey>([
      ...(await indexesFromMigrations()),
      ...(await indexesFromMigrations(stubEnrichmentStore())),
      ...(await indexesFromMigrations(stubEnrichmentStore(), new Set(["git.chunk.ageDays"]))),
    ]);

    expect([...fromInit].sort()).toEqual([...fromMigrations].sort());
  });
});
