import { describe, expect, it, vi } from "vitest";

import { QdrantOperationError } from "../../../../../../src/core/adapters/qdrant/errors.js";
import {
  RECENT_AUTHORS_FILTER_INDEXES,
  SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS,
} from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { MigrationStepError } from "../../../../../../src/core/domains/maintenance/migration/errors.js";
import { Migrator } from "../../../../../../src/core/domains/maintenance/migration/migrator.js";
import { SchemaV18RecentAuthorsIndex } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v18-recent-authors-index.js";
import type { IndexStore, MigrationRunner } from "../../../../../../src/core/domains/maintenance/migration/types.js";
import { gitFilters } from "../../../../../../src/core/domains/trajectory/git/filters.js";

/**
 * An index store holding a live inventory: `ensureIndex` creates an entry only
 * when the field has none, so a second `apply()` sees what the first one left.
 */
function createMockStore(existing: string[] = []): IndexStore & { inventory: Map<string, string> } {
  const inventory = new Map(existing.map((field) => [field, "keyword"]));
  return {
    inventory,
    getSchemaVersion: vi.fn().mockResolvedValue(17),
    ensureIndex: vi.fn(async (_collection: string, field: string, type: string) => {
      if (inventory.has(field)) return false;
      inventory.set(field, type);
      return true;
    }),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn(async (_collection: string, field: string) => inventory.has(field)),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
  };
}

const COLLECTION = "code_test";

describe("SchemaV18RecentAuthorsIndex", () => {
  it("declares version 18 and a matching name", () => {
    const migration = new SchemaV18RecentAuthorsIndex(COLLECTION, createMockStore());
    expect(migration.version).toBe(18);
    expect(migration.name).toBe("schema-v18-recent-authors-index");
  });

  // The `contributor` typed filter compiles to a `match.any` on this key. The
  // payload value is the recent-window author NAME list; a keyword index serves
  // the membership test, and without one Qdrant reads every candidate's payload.
  it("indexes git.file.recentAuthors as keyword", async () => {
    const store = createMockStore();
    const migration = new SchemaV18RecentAuthorsIndex(COLLECTION, store);

    await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.file.recentAuthors", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledTimes(RECENT_AUTHORS_FILTER_INDEXES.length);
  });

  it("reports every path it ensured, so the schema-metadata audit lists them", async () => {
    const migration = new SchemaV18RecentAuthorsIndex(COLLECTION, createMockStore());

    const result = await migration.apply();

    expect(result.applied).toEqual(["git.file.recentAuthors:keyword"]);
  });

  it("is idempotent — a second pass creates nothing", async () => {
    const store = createMockStore();
    const migration = new SchemaV18RecentAuthorsIndex(COLLECTION, store);

    await migration.apply();
    vi.mocked(store.ensureIndex).mockClear();
    await migration.apply();

    const createdOnSecondPass = await Promise.all(vi.mocked(store.ensureIndex).mock.results.map((r) => r.value));
    expect(createdOnSecondPass).toEqual([false]);
    expect(store.inventory.size).toBe(1);
  });

  // The drift guard (schema-v16) drops any payload index its declared-key set
  // does not name. The key is schema-managed, so v16 accepts it on every
  // collection — indexed here AND never dropped by the reconcile.
  it("is a schema-managed key, so the drift guard accepts the index", () => {
    expect(SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS).toContain("git.file.recentAuthors");
  });

  // The index list and the filter descriptors are mirrored by hand across the
  // domain boundary — pinned both ways so the filter cannot lose its index (or
  // the list outlive the filter) unnoticed.
  it("indexes exactly the recentAuthors key the contributor filter emits", () => {
    const emitted = new Set<string>();
    for (const descriptor of gitFilters) {
      for (const condition of descriptor.toCondition("Alice", undefined).must ?? []) {
        const node = condition as { key?: string; match?: { any?: unknown[] } };
        if (node.key?.endsWith(".recentAuthors")) emitted.add(node.key);
      }
    }
    expect(emitted).toEqual(new Set(RECENT_AUTHORS_FILTER_INDEXES.map(({ path }) => path)));
    expect(RECENT_AUTHORS_FILTER_INDEXES.every(({ schema }) => schema === "keyword")).toBe(true);
  });

  // Resumable: the pipeline stamps the version only after every step
  // succeeded, so a run that failed mid-way re-runs v18 in full — the index
  // that already exists costs a lookup, a missing one is created.
  it("surfaces a failed index build as a typed migration error and leaves the version unstamped", async () => {
    const store = createMockStore();
    vi.mocked(store.ensureIndex).mockRejectedValue(new QdrantOperationError("createPayloadIndex", "timeout"));
    const runner: MigrationRunner = {
      latestVersion: 18,
      getVersion: async () => 17,
      setVersion: vi.fn().mockResolvedValue(undefined),
      getMigrations: () => [new SchemaV18RecentAuthorsIndex(COLLECTION, store)],
    };
    const noop: MigrationRunner = {
      latestVersion: 0,
      getVersion: async () => 0,
      setVersion: async () => undefined,
      getMigrations: () => [],
    };
    const migrator = new Migrator({ schema: runner, snapshot: noop, sparse: noop, stats: noop });

    const failure = await migrator.run("schema").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MigrationStepError);
    expect((failure as MigrationStepError).message).toContain("schema-v18-recent-authors-index");
    expect(runner.setVersion).not.toHaveBeenCalled();
  });
});
