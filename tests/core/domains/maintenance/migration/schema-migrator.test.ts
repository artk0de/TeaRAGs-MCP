import { describe, expect, it, vi } from "vitest";

import { SchemaMigrator } from "../../../../../src/core/domains/maintenance/migration/schema-migrator.js";
import { SparseMigrator } from "../../../../../src/core/domains/maintenance/migration/sparse-migrator.js";
import type {
  IndexStore,
  SnapshotStore,
  SparseStore,
} from "../../../../../src/core/domains/maintenance/migration/types.js";

function createMockIndexStore(version = 0): IndexStore {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(version),
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

function createMockSparseStore(version = 0): SparseStore {
  return {
    getSparseVersion: vi.fn().mockResolvedValue(version),
    rebuildSparseVectors: vi.fn().mockResolvedValue(undefined),
    storeSparseVersion: vi.fn().mockResolvedValue(undefined),
  };
}

const COLLECTION = "test_col";

describe("SchemaMigrator", () => {
  it("has 11 schema migrations (v4-v15) without enrichment store", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), { enableHybrid: false });
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(11);
    expect(migrations.filter((m) => m.version >= 4 && m.version <= 15)).toHaveLength(11);
  });

  it("has 12 schema migrations (v4-v15) with enrichment store", () => {
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
      mockEnrichmentStore,
    );
    const migrations = migrator.getMigrations();
    expect(migrations).toHaveLength(12);
    expect(migrations.find((m) => m.version === 9)).toBeDefined();
    expect(migrations.find((m) => m.version === 10)).toBeDefined();
    expect(migrations.find((m) => m.version === 11)).toBeDefined();
    expect(migrations.find((m) => m.version === 12)).toBeDefined();
    expect(migrations.find((m) => m.version === 14)).toBeDefined();
    expect(migrations.find((m) => m.version === 15)).toBeDefined();
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
    expect(migrator.latestVersion).toBe(15);
  });

  it("computes latestVersion=15 with enrichment store", () => {
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
      mockEnrichmentStore,
    );
    expect(migrator.latestVersion).toBe(15);
  });

  // bd tea-rags-mcp-q34ic — v16 drops indexes nothing declares, so it exists
  // only when the caller hands over the declared key set. Without one there is
  // no migration to stamp past: the collection stays at 15 and the next run
  // that has the set performs the drop.
  it("registers v16 when the declared trajectory payload keys are supplied", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), {
      enableHybrid: false,
      declaredPayloadKeys: new Set(["git.chunk.ageDays"]),
    });
    expect(migrator.getMigrations().find((m) => m.version === 16)?.name).toBe(
      "schema-v16-drop-undeclared-payload-indexes",
    );
    expect(migrator.latestVersion).toBe(16);
  });

  it("does not register v16 from an empty declared key set", () => {
    const migrator = new SchemaMigrator(COLLECTION, createMockIndexStore(), {
      enableHybrid: false,
      declaredPayloadKeys: new Set(),
    });
    expect(migrator.getMigrations().find((m) => m.version === 16)).toBeUndefined();
    expect(migrator.latestVersion).toBe(15);
  });

  it("stores version via IndexStore after migrations", async () => {
    const store = createMockIndexStore(7);
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    await migrator.setVersion(8);
    expect(store.storeSchemaVersion).toHaveBeenCalledWith(COLLECTION, 8, expect.any(Array));
  });
});

describe("individual schema migrations", () => {
  // bd tea-rags-mcp-ivp12 — v4's keyword index was replaced by v5's text index
  // one step later in the same run, on every collection, always: Qdrant keeps
  // ONE index per key. The invariant is that `relativePath` ends up TEXT-indexed
  // and no collection pays to build an index that cannot survive, so v4 now
  // creates nothing and v5 (below) is the step that gives the key its index.
  it("v4 creates no index — v5's text index on the same key replaces it", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v4 = migrator.getMigrations().find((m) => m.version === 4)!;
    const result = await v4.apply();
    expect(store.ensureIndex).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
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

  it("v10 deletes markdown chunks and invalidates snapshot entries", async () => {
    const store = createMockIndexStore();
    const snapshotStore: SnapshotStore = {
      getFormat: vi.fn(),
      readV1: vi.fn(),
      readV2: vi.fn(),
      writeSharded: vi.fn(),
      backup: vi.fn(),
      deleteOld: vi.fn(),
      statFile: vi.fn(),
      invalidateByExtensions: vi.fn().mockResolvedValue(3),
    };
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false }, undefined, snapshotStore);
    const v10 = migrator.getMigrations().find((m) => m.version === 10)!;
    const result = await v10.apply();

    expect(store.deletePointsByFilter).toHaveBeenCalledWith(COLLECTION, {
      must: [{ key: "language", match: { value: "markdown" } }],
    });
    expect(snapshotStore.invalidateByExtensions).toHaveBeenCalledWith([".md", ".markdown"]);
    expect(result.applied).toContain("deleted markdown chunks from Qdrant");
    expect(result.applied).toContain("invalidated 3 markdown file(s) in snapshot");
  });

  it("v10 works without snapshotStore", async () => {
    const store = createMockIndexStore();
    const migrator = new SchemaMigrator(COLLECTION, store, { enableHybrid: false });
    const v10 = migrator.getMigrations().find((m) => m.version === 10)!;
    const result = await v10.apply();

    expect(store.deletePointsByFilter).toHaveBeenCalledWith(COLLECTION, {
      must: [{ key: "language", match: { value: "markdown" } }],
    });
    expect(result.applied).toHaveLength(1);
    expect(result.applied).toContain("deleted markdown chunks from Qdrant");
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
