import { describe, expect, it, vi } from "vitest";

import { SchemaV11RenameParentSymbolId } from "../../../../src/core/infra/migration/schema_migrations/schema-v11-rename-parent-symbol-id.js";

const COLLECTION = "test_col";

function createV11Store() {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(10),
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

describe("SchemaV11RenameParentSymbolId", () => {
  it("renames parentName → parentSymbolId and creates text index", async () => {
    const store = createV11Store();
    store.scrollAllPayload.mockResolvedValue([
      { id: "p1", payload: { parentName: "MyClass", chunkType: "function" } },
      { id: "p2", payload: { parentName: "OtherClass", chunkType: "method" } },
      { id: "p3", payload: { chunkType: "module" } },
    ]);

    const migration = new SchemaV11RenameParentSymbolId(COLLECTION, store);
    const result = await migration.apply();

    // Should batch-set parentSymbolId only for points with parentName
    expect(store.batchSetPayload).toHaveBeenCalledWith(COLLECTION, [
      { points: ["p1"], payload: { parentSymbolId: "MyClass" } },
      { points: ["p2"], payload: { parentSymbolId: "OtherClass" } },
    ]);

    // Should delete old parentName field
    expect(store.deletePayloadKeys).toHaveBeenCalledWith(COLLECTION, ["parentName"]);

    // Should create text index on parentSymbolId
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "parentSymbolId", "text");

    expect(result.applied).toContain("renamed parentName → parentSymbolId on 2 points");
    expect(result.applied).toContain("deleted parentName field");
    expect(result.applied).toContain("created text index on parentSymbolId");
  });

  it("skips batch when no points have parentName", async () => {
    const store = createV11Store();
    store.scrollAllPayload.mockResolvedValue([
      { id: "p1", payload: { chunkType: "module" } },
      { id: "p2", payload: { parentSymbolId: "AlreadyMigrated" } },
    ]);

    const migration = new SchemaV11RenameParentSymbolId(COLLECTION, store);
    const result = await migration.apply();

    expect(store.batchSetPayload).not.toHaveBeenCalled();
    expect(result.applied).toContain("no points with parentName — skip rename");
  });

  it("always deletes parentName field and creates index even when no points to rename", async () => {
    const store = createV11Store();
    store.scrollAllPayload.mockResolvedValue([]);

    const migration = new SchemaV11RenameParentSymbolId(COLLECTION, store);
    const result = await migration.apply();

    expect(store.deletePayloadKeys).toHaveBeenCalledWith(COLLECTION, ["parentName"]);
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "parentSymbolId", "text");
    expect(result.applied).toContain("deleted parentName field");
    expect(result.applied).toContain("created text index on parentSymbolId");
  });
});
