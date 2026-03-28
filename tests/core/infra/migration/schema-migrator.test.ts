import { describe, expect, it, vi } from "vitest";

import { SchemaMigrator } from "../../../../src/core/infra/migration/schema-migrator.js";
import type { IndexStore, SparseStore } from "../../../../src/core/infra/migration/types.js";

function createMockIndexStore(version = 0): IndexStore {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(version),
    ensureIndex: vi.fn().mockResolvedValue(true),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn().mockResolvedValue(false),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSparseStore(version = 0): SparseStore {
  return {
    getSparseVersion: vi.fn().mockResolvedValue(version),
    rebuildSparseVectors: vi.fn().mockResolvedValue(undefined),
    storeSparseVersion: vi.fn().mockResolvedValue(undefined),
  };
}

const COLLECTION = "test_col";

describe("SchemaMigrator", () => {
  it("has 5 schema migrations + 1 sparse rebuild", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), createMockSparseStore(), { enableHybrid: false });
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(6);
    // Schema migrations v4-v8
    expect(migrations.filter(m => m.version >= 4 && m.version <= 8)).toHaveLength(5);
    // Sparse rebuild at version 100
    expect(migrations.find(m => m.version === 100)).toBeDefined();
  });

  it("reads schema version from IndexStore", async () => {
    const store = createMockIndexStore(6);
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const version = await migrator.getVersion();
    expect(version).toBe(6);
    expect(store.getSchemaVersion).toHaveBeenCalledWith(COLLECTION);
  });

  it("stores version via IndexStore after migrations", async () => {
    const store = createMockIndexStore(7);
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    await migrator.setVersion(8);
    expect(store.storeSchemaVersion).toHaveBeenCalledWith(COLLECTION, 8, expect.any(Array));
  });
});

describe("individual schema migrations", () => {
  it("v4 creates keyword index on relativePath", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const v4 = migrator.getMigrations().find(m => m.version === 4)!;
    await v4.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "relativePath", "keyword");
  });

  it("v5 creates text index on relativePath", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const v5 = migrator.getMigrations().find(m => m.version === 5)!;
    await v5.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "relativePath", "text");
  });

  it("v6 creates indexes on language, fileExtension, chunkType", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const v6 = migrator.getMigrations().find(m => m.version === 6)!;
    await v6.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "language", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "fileExtension", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "chunkType", "keyword");
  });

  it("v7 enables sparse config when enableHybrid=true and not already enabled", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: true });
    const v7 = migrator.getMigrations().find(m => m.version === 7)!;
    await v7.apply();
    expect(store.updateSparseConfig).toHaveBeenCalledWith(COLLECTION);
  });

  it("v7 skips when enableHybrid=false", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const v7 = migrator.getMigrations().find(m => m.version === 7)!;
    const result = await v7.apply();
    expect(store.updateSparseConfig).not.toHaveBeenCalled();
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("v7 skips when already hybridEnabled", async () => {
    const store = createMockIndexStore();
    (store.getCollectionInfo as ReturnType<typeof vi.fn>).mockResolvedValue({ hybridEnabled: true, vectorSize: 384 });
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: true });
    const v7 = migrator.getMigrations().find(m => m.version === 7)!;
    const result = await v7.apply();
    expect(store.updateSparseConfig).not.toHaveBeenCalled();
  });

  it("v8 creates text index on symbolId", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, createMockSparseStore(), { enableHybrid: false });
    const v8 = migrator.getMigrations().find(m => m.version === 8)!;
    await v8.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "symbolId", "text");
  });

  it("sparse rebuild runs when version outdated and hybrid enabled", async () => {
    const sparseStore = createMockSparseStore(0);
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), sparseStore, { enableHybrid: true });
    const sparse = migrator.getMigrations().find(m => m.version === 100)!;
    await sparse.apply();
    expect(sparseStore.rebuildSparseVectors).toHaveBeenCalledWith(COLLECTION);
    expect(sparseStore.storeSparseVersion).toHaveBeenCalledWith(COLLECTION, 1);
  });

  it("sparse rebuild skips when hybrid disabled", async () => {
    const sparseStore = createMockSparseStore(0);
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), sparseStore, { enableHybrid: false });
    const sparse = migrator.getMigrations().find(m => m.version === 100)!;
    const result = await sparse.apply();
    expect(sparseStore.rebuildSparseVectors).not.toHaveBeenCalled();
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("sparse rebuild skips when already at current version", async () => {
    const sparseStore = createMockSparseStore(1); // already at v1
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), sparseStore, { enableHybrid: true });
    const sparse = migrator.getMigrations().find(m => m.version === 100)!;
    const result = await sparse.apply();
    expect(sparseStore.rebuildSparseVectors).not.toHaveBeenCalled();
  });
});
