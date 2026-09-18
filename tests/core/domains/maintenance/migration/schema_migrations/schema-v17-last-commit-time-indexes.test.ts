import { describe, expect, it, vi } from "vitest";

import { QdrantOperationError } from "../../../../../../src/core/adapters/qdrant/errors.js";
import { LAST_COMMIT_TIME_FILTER_INDEXES } from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { MigrationStepError } from "../../../../../../src/core/domains/maintenance/migration/errors.js";
import { Migrator } from "../../../../../../src/core/domains/maintenance/migration/migrator.js";
import { SchemaV17LastCommitTimeIndexes } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v17-last-commit-time-indexes.js";
import type { IndexStore, MigrationRunner } from "../../../../../../src/core/domains/maintenance/migration/types.js";

/**
 * An index store holding a live inventory: `ensureIndex` creates an entry only
 * when the field has none, so a second `apply()` sees what the first one left.
 */
function createMockStore(existing: string[] = []): IndexStore & { inventory: Map<string, string> } {
  const inventory = new Map(existing.map((field) => [field, "integer"]));
  return {
    inventory,
    getSchemaVersion: vi.fn().mockResolvedValue(16),
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

describe("SchemaV17LastCommitTimeIndexes", () => {
  it("declares version 17 and a matching name", () => {
    const migration = new SchemaV17LastCommitTimeIndexes(COLLECTION, createMockStore());
    expect(migration.version).toBe(17);
    expect(migration.name).toBe("schema-v17-last-commit-time-indexes");
  });

  // The age filters (minAgeDays / maxAgeDays at either level) and
  // modifiedAfter / modifiedBefore compile to a `range` on these keys. The
  // stored value is a whole-second commit timestamp, so an integer index
  // serves the range; without one Qdrant reads every candidate's payload
  // (measured 1.4 ms → 304–441 ms count on the 24.6k-point self-index).
  it("indexes both last-commit timestamps as integer", async () => {
    const store = createMockStore();
    const migration = new SchemaV17LastCommitTimeIndexes(COLLECTION, store);

    await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.file.lastModifiedAt", "integer");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.chunk.lastModifiedAt", "integer");
    expect(store.ensureIndex).toHaveBeenCalledTimes(LAST_COMMIT_TIME_FILTER_INDEXES.length);
  });

  it("reports every path it ensured, so the schema-metadata audit lists them", async () => {
    const migration = new SchemaV17LastCommitTimeIndexes(COLLECTION, createMockStore());

    const result = await migration.apply();

    expect(result.applied).toEqual(["git.file.lastModifiedAt:integer", "git.chunk.lastModifiedAt:integer"]);
  });

  it("is idempotent — a second pass creates nothing", async () => {
    const store = createMockStore();
    const migration = new SchemaV17LastCommitTimeIndexes(COLLECTION, store);

    await migration.apply();
    vi.mocked(store.ensureIndex).mockClear();
    await migration.apply();

    const createdOnSecondPass = await Promise.all(vi.mocked(store.ensureIndex).mock.results.map((r) => r.value));
    expect(createdOnSecondPass).toEqual([false, false]);
    expect(store.inventory.size).toBe(2);
  });

  // Resumable: the pipeline stamps the version only after every step
  // succeeded, so a run that created the file index and then failed re-runs
  // v17 in full — the index that already exists costs a lookup, the missing
  // one is created.
  it("finishes the job on the re-run after a partial failure", async () => {
    const store = createMockStore();
    vi.mocked(store.ensureIndex)
      .mockImplementationOnce(async (_c, field, type) => {
        store.inventory.set(field, type);
        return true;
      })
      .mockRejectedValueOnce(new QdrantOperationError("createPayloadIndex", "timeout"));
    const migration = new SchemaV17LastCommitTimeIndexes(COLLECTION, store);

    await expect(migration.apply()).rejects.toBeInstanceOf(QdrantOperationError);
    expect([...store.inventory.keys()]).toEqual(["git.file.lastModifiedAt"]);

    await migration.apply();
    expect([...store.inventory.keys()].sort()).toEqual(["git.chunk.lastModifiedAt", "git.file.lastModifiedAt"]);
  });

  it("surfaces a failed index build as a typed migration error and leaves the version unstamped", async () => {
    const store = createMockStore();
    vi.mocked(store.ensureIndex).mockRejectedValue(new QdrantOperationError("createPayloadIndex", "timeout"));
    const runner: MigrationRunner = {
      latestVersion: 17,
      getVersion: async () => 16,
      setVersion: vi.fn().mockResolvedValue(undefined),
      getMigrations: () => [new SchemaV17LastCommitTimeIndexes(COLLECTION, store)],
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
    expect((failure as MigrationStepError).message).toContain("schema-v17-last-commit-time-indexes");
    expect(runner.setVersion).not.toHaveBeenCalled();
  });
});
