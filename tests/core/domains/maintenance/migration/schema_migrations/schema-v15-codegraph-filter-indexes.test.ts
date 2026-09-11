import { describe, expect, it, vi } from "vitest";

import { CODEGRAPH_FILTER_INDEXES } from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaV15CodegraphFilterIndexes } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v15-codegraph-filter-indexes.js";
import type { IndexStore } from "../../../../../../src/core/domains/maintenance/migration/types.js";

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

describe("SchemaV15CodegraphFilterIndexes", () => {
  const COLLECTION = "test_col";

  it("declares version 15 and a matching name", () => {
    const migration = new SchemaV15CodegraphFilterIndexes(COLLECTION, createMockStore());
    expect(migration.version).toBe(15);
    expect(migration.name).toBe("schema-v15-codegraph-filter-indexes");
  });

  it("indexes every nested path a typed codegraph filter resolves to", async () => {
    const store = createMockStore();
    const migration = new SchemaV15CodegraphFilterIndexes(COLLECTION, store);

    await migration.apply();

    // The schema per path is what makes the index usable: a `range` filter on a
    // path indexed as `keyword` is not served by that index.
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.fanIn", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.fanOut", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.connectionCount", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.transitiveImpact", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.instability", "float");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.isHub", "bool");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.isLeaf", "bool");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.chunk.fanIn", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.chunk.fanOut", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.chunk.pageRank", "float");
    expect(store.ensureIndex).toHaveBeenCalledTimes(CODEGRAPH_FILTER_INDEXES.length);
  });

  it("reports every path it ensured, so the schema-metadata audit lists them", async () => {
    const store = createMockStore();
    const migration = new SchemaV15CodegraphFilterIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(result.applied).toEqual(CODEGRAPH_FILTER_INDEXES.map(({ path, schema }) => `${path}:${schema}`));
  });

  it("is idempotent when the indexes already exist (ensureIndex returns false)", async () => {
    const store = createMockStore();
    store.ensureIndex = vi.fn().mockResolvedValue(false);
    const migration = new SchemaV15CodegraphFilterIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledTimes(CODEGRAPH_FILTER_INDEXES.length);
    expect(result.applied).toHaveLength(CODEGRAPH_FILTER_INDEXES.length);
  });
});
