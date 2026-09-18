import { describe, expect, it, vi } from "vitest";

import type { PayloadFieldIndex } from "../../../../../../src/core/adapters/qdrant/payload-index.js";
import { SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS } from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaV16DropUndeclaredPayloadIndexes } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v16-drop-undeclared-payload-indexes.js";
import type { IndexStore } from "../../../../../../src/core/domains/maintenance/migration/types.js";

type ReconcilingIndexStore = IndexStore & Required<Pick<IndexStore, "listPayloadIndexes" | "dropPayloadIndex">>;

/**
 * An index store holding a live inventory: `dropPayloadIndex` removes the entry,
 * so a second `apply()` sees what the first one left behind.
 */
function createMockStore(indexes: PayloadFieldIndex[]): ReconcilingIndexStore {
  const inventory = new Map(indexes.map((index) => [index.field, index]));
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(15),
    ensureIndex: vi.fn().mockResolvedValue(false),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn().mockResolvedValue(false),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
    listPayloadIndexes: vi.fn(async () => [...inventory.values()]),
    dropPayloadIndex: vi.fn(async (_collection: string, field: string) => {
      inventory.delete(field);
    }),
  };
}

const COLLECTION = "code_test";

/** Keys a trajectory declares — the lazily-indexed rank_chunks order_by fields among them. */
const TRAJECTORY_KEYS = new Set(["git.chunk.ageDays", "git.file.commitCount", "methodLines", "language"]);

const LEGACY_GIT_CODEGRAPH_INDEXES: PayloadFieldIndex[] = [
  { field: "git.file.fanIn", dataType: "float", points: 0 },
  { field: "git.file.fanOut", dataType: "float", points: 0 },
  { field: "git.file.transitiveImpact", dataType: "float", points: 0 },
  { field: "git.file.isHub", dataType: "float", points: 0 },
  { field: "git.chunk.fanIn", dataType: "float", points: 0 },
  { field: "git.chunk.fanOut", dataType: "float", points: 0 },
  { field: "git.chunk.pageRank", dataType: "float", points: 0 },
];

describe("SchemaV16DropUndeclaredPayloadIndexes", () => {
  it("declares version 16 and a matching name", () => {
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, createMockStore([]), TRAJECTORY_KEYS);
    expect(migration.version).toBe(16);
    expect(migration.name).toBe("schema-v16-drop-undeclared-payload-indexes");
  });

  it("drops every index whose key no source declares, and names each one in the step result", async () => {
    const store = createMockStore([
      { field: "relativePath", dataType: "text", points: 24622 },
      ...LEGACY_GIT_CODEGRAPH_INDEXES,
    ]);
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, store, TRAJECTORY_KEYS);

    const result = await migration.apply();

    expect(vi.mocked(store.dropPayloadIndex).mock.calls.map(([, field]) => field)).toEqual(
      LEGACY_GIT_CODEGRAPH_INDEXES.map((index) => index.field).sort(),
    );
    expect(vi.mocked(store.dropPayloadIndex).mock.calls.every(([collection]) => collection === COLLECTION)).toBe(true);
    expect(result.applied).toEqual(
      LEGACY_GIT_CODEGRAPH_INDEXES.map((index) => index.field)
        .sort()
        .map((field) => `dropped ${field}:float (0 points)`),
    );
  });

  // `git.file.skippedAs` carries no value on the self-index (ram 0, like the
  // legacy keys) but the enrichment recovery scan filters on it. "Nothing is
  // stored under the key right now" is not the drop criterion; "nothing
  // declares the key" is.
  it("keeps a declared index even when no point carries the key", async () => {
    const store = createMockStore([
      { field: "git.file.skippedAs", dataType: "keyword", points: 0 },
      { field: "git.file.fanIn", dataType: "float", points: 0 },
    ]);
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, store, TRAJECTORY_KEYS);

    await migration.apply();

    expect(store.dropPayloadIndex).toHaveBeenCalledTimes(1);
    expect(store.dropPayloadIndex).toHaveBeenCalledWith(COLLECTION, "git.file.fanIn");
  });

  it("keeps every index the schema manager creates, whatever the trajectory keys say", async () => {
    const store = createMockStore(
      SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS.map((field) => ({ field, dataType: "keyword", points: 0 })),
    );
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, store, new Set(["methodLines"]));

    const result = await migration.apply();

    expect(store.dropPayloadIndex).not.toHaveBeenCalled();
    expect(result.applied).toEqual(["no undeclared payload indexes"]);
  });

  it("keeps the order_by indexes rank_chunks created on keys a trajectory declares", async () => {
    const store = createMockStore([
      { field: "git.chunk.ageDays", dataType: "integer", points: 20603 },
      { field: "methodLines", dataType: "integer", points: 12892 },
    ]);
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, store, TRAJECTORY_KEYS);

    await migration.apply();

    expect(store.dropPayloadIndex).not.toHaveBeenCalled();
  });

  it("is idempotent — a second pass over what the first left finds nothing to drop", async () => {
    const store = createMockStore([
      { field: "chunkType", dataType: "keyword", points: 10 },
      ...LEGACY_GIT_CODEGRAPH_INDEXES,
    ]);
    const migration = new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, store, TRAJECTORY_KEYS);

    await migration.apply();
    vi.mocked(store.dropPayloadIndex).mockClear();
    const second = await migration.apply();

    expect(store.dropPayloadIndex).not.toHaveBeenCalled();
    expect(second.applied).toEqual(["no undeclared payload indexes"]);
  });

  // An empty declared set is a failed build, not a statement that nothing is
  // declared — every trajectory-owned lazy index would read as an orphan.
  it("refuses to be built from an empty trajectory key set", () => {
    expect(() => new SchemaV16DropUndeclaredPayloadIndexes(COLLECTION, createMockStore([]), new Set())).toThrow(
      /declared/i,
    );
  });
});
