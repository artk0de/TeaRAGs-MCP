import { describe, expect, it, vi } from "vitest";

import { SchemaMigrator } from "../../../../src/core/infra/migration/schema-migrator.js";
import { SparseMigrator } from "../../../../src/core/infra/migration/sparse-migrator.js";
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
  it("has 5 schema migrations (v4-v8) without enrichment store", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), { enableHybrid: false });
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(5);
    expect(migrations.filter((m) => m.version >= 4 && m.version <= 8)).toHaveLength(5);
  });

  it("has 6 schema migrations (v4-v9) with enrichment store", () => {
    const mockEnrichmentStore = {
      isMigrated: vi.fn(),
      scrollAllChunks: vi.fn(),
      batchSetPayload: vi.fn(),
      markMigrated: vi.fn(),
    };
    const migrator = new SchemaMigrator(
      COLLECTION,
      createMockIndexStore(),
      { enableHybrid: false, providerKey: "git" },
      mockEnrichmentStore as any,
    );
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(6);
    expect(migrations.find((m) => m.version === 9)).toBeDefined();
  });

  it("reads schema version from IndexStore", async () => {
    const store = createMockIndexStore(6);
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const version = await migrator.getVersion();
    expect(version).toBe(6);
    expect(store.getSchemaVersion).toHaveBeenCalledWith(COLLECTION);
  });

  it("computes latestVersion from registered migrations", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), { enableHybrid: false });
    expect(migrator.latestVersion).toBe(8);
  });

  it("computes latestVersion=9 with enrichment store", () => {
    const mockEnrichmentStore = {
      isMigrated: vi.fn(),
      scrollAllChunks: vi.fn(),
      batchSetPayload: vi.fn(),
      markMigrated: vi.fn(),
    };
    const migrator = new SchemaMigrator(
      COLLECTION,
      createMockIndexStore(),
      { enableHybrid: false, providerKey: "git" },
      mockEnrichmentStore as any,
    );
    expect(migrator.latestVersion).toBe(9);
  });

  it("stores version via IndexStore after migrations", async () => {
    const store = createMockIndexStore(7);
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    await migrator.setVersion(8);
    expect(store.storeSchemaVersion).toHaveBeenCalledWith(COLLECTION, 8, expect.any(Array));
  });
});

describe("individual schema migrations", () => {
  it("v4 creates keyword index on relativePath", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v4 = migrator.getMigrations().find((m) => m.version === 4)!;
    await v4.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "relativePath", "keyword");
  });

  it("v5 creates text index on relativePath", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v5 = migrator.getMigrations().find((m) => m.version === 5)!;
    await v5.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "relativePath", "text");
  });

  it("v6 creates indexes on language, fileExtension, chunkType", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v6 = migrator.getMigrations().find((m) => m.version === 6)!;
    await v6.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "language", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "fileExtension", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "chunkType", "keyword");
  });

  it("v7 enables sparse config when enableHybrid=true and not already enabled", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: true });
    const v7 = migrator.getMigrations().find((m) => m.version === 7)!;
    await v7.apply();
    expect(store.updateSparseConfig).toHaveBeenCalledWith(COLLECTION);
  });

  it("v7 skips when enableHybrid=false", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v7 = migrator.getMigrations().find((m) => m.version === 7)!;
    const result = await v7.apply();
    expect(store.updateSparseConfig).not.toHaveBeenCalled();
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("v7 skips when already hybridEnabled", async () => {
    const store = createMockIndexStore();
    (store.getCollectionInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      hybridEnabled: true,
      vectorSize: 384,
    });
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: true });
    const v7 = migrator.getMigrations().find((m) => m.version === 7)!;
    await v7.apply();
    expect(store.updateSparseConfig).not.toHaveBeenCalled();
  });

  it("v8 creates text index on symbolId", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v8 = migrator.getMigrations().find((m) => m.version === 8)!;
    await v8.apply();
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "symbolId", "text");
  });
});

describe("SparseMigrator", () => {
  it("has 1 sparse migration", () => {
    const migrator = new SparseMigrator(COLLECTION, createMockSparseStore(), false);
    expect(migrator.getMigrations()).toHaveLength(1);
    expect(migrator.getMigrations()[0].version).toBe(1);
  });

  it("computes latestVersion from registered migrations", () => {
    const migrator = new SparseMigrator(COLLECTION, createMockSparseStore(), false);
    expect(migrator.latestVersion).toBe(1);
  });

  it("reads version from SparseStore", async () => {
    const store = createMockSparseStore(1);
    const migrator = new SparseMigrator(COLLECTION, store, false);
    expect(await migrator.getVersion()).toBe(1);
  });

  it("stores version via SparseStore", async () => {
    const store = createMockSparseStore();
    const migrator = new SparseMigrator(COLLECTION, store, false);
    await migrator.setVersion(2);
    expect(store.storeSparseVersion).toHaveBeenCalledWith(COLLECTION, 2);
  });

  it("sparse rebuild runs when hybrid enabled", async () => {
    const store = createMockSparseStore(0);
    const migrator = new SparseMigrator(COLLECTION, store, true);
    const sparse = migrator.getMigrations()[0];
    await sparse.apply();
    expect(store.rebuildSparseVectors).toHaveBeenCalledWith(COLLECTION);
    // storeSparseVersion is NOT called by apply() — Migrator.setVersion() handles it
  });

  it("sparse rebuild skips when hybrid disabled", async () => {
    const store = createMockSparseStore(0);
    const migrator = new SparseMigrator(COLLECTION, store, false);
    const sparse = migrator.getMigrations()[0];
    const result = await sparse.apply();
    expect(store.rebuildSparseVectors).not.toHaveBeenCalled();
    expect(result.applied).toEqual(expect.arrayContaining([expect.stringContaining("skipped")]));
  });

  it("version gating is handled by Migrator, not apply()", async () => {
    // If Migrator calls apply(), version check already passed.
    // apply() only checks enableHybrid flag.
    const store = createMockSparseStore(1);
    const migrator = new SparseMigrator(COLLECTION, store, true);
    const sparse = migrator.getMigrations()[0];
    await sparse.apply();
    // Even with sparseVersion=1, apply() runs because Migrator already filtered
    expect(store.rebuildSparseVectors).toHaveBeenCalledWith(COLLECTION);
  });
});
