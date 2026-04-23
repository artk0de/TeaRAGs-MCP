import { describe, expect, it, vi } from "vitest";

import { SchemaV12EnrichmentPayloadIndexes } from "../../../../../src/core/infra/migration/schema_migrations/schema-v12-enrichment-payload-indexes.js";
import type { IndexStore } from "../../../../../src/core/infra/migration/types.js";

function createMockStore(): IndexStore {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(0),
    ensureIndex: vi.fn().mockResolvedValue(true),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn().mockResolvedValue(false),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
    scrollAllPayload: vi.fn().mockResolvedValue([]),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    deletePayloadKeys: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SchemaV12EnrichmentPayloadIndexes", () => {
  const COLLECTION = "test_col";

  it("declares version 12 and a matching name", () => {
    const store = createMockStore();
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);
    expect(migration.version).toBe(12);
    expect(migration.name).toBe("schema-v12-enrichment-payload-indexes");
  });

  it("ensures datetime indexes on git.file.enrichedAt and git.chunk.enrichedAt", async () => {
    const store = createMockStore();
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.file.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.chunk.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledTimes(2);

    expect(result.applied).toEqual(["git.file.enrichedAt:datetime", "git.chunk.enrichedAt:datetime"]);
  });

  it("is idempotent when indexes already exist (ensureIndex returns false)", async () => {
    const store = createMockStore();
    store.ensureIndex = vi.fn().mockResolvedValue(false);
    const migration = new SchemaV12EnrichmentPayloadIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledTimes(2);
    expect(result.applied).toEqual(["git.file.enrichedAt:datetime", "git.chunk.enrichedAt:datetime"]);
  });
});
