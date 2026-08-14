import { describe, expect, it, vi } from "vitest";

import { ENRICHMENT_SCAN_INDEXES } from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";
import { SchemaV14EnrichmentScanIndexes } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v14-enrichment-scan-indexes.js";
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

describe("SchemaV14EnrichmentScanIndexes", () => {
  const COLLECTION = "test_col";

  it("declares version 14 and a matching name", () => {
    const migration = new SchemaV14EnrichmentScanIndexes(COLLECTION, createMockStore());
    expect(migration.version).toBe(14);
    expect(migration.name).toBe("schema-v14-enrichment-scan-indexes");
  });

  it("indexes every field the enrichment scans filter on", async () => {
    const store = createMockStore();
    const migration = new SchemaV14EnrichmentScanIndexes(COLLECTION, store);

    await migration.apply();

    // `_type` carries the two must_not conditions shared by the recompute
    // scroll and the unenriched scan; unindexed it costs a payload lookup per
    // candidate point (measured: 6.3s -> 0.7s over 39k taxdome TS chunks).
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "_type", "keyword");
    // Both terminal states of the settle decision, both levels, both providers.
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.file.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.file.skippedAs", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.chunk.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "git.chunk.skippedAs", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.file.skippedAs", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.chunk.enrichedAt", "datetime");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "codegraph.symbols.chunk.skippedAs", "keyword");
    expect(store.ensureIndex).toHaveBeenCalledTimes(ENRICHMENT_SCAN_INDEXES.length);
  });

  it("reports every path it ensured, so the schema-metadata audit lists them", async () => {
    const store = createMockStore();
    const migration = new SchemaV14EnrichmentScanIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(result.applied).toEqual(ENRICHMENT_SCAN_INDEXES.map(({ path, schema }) => `${path}:${schema}`));
  });

  it("is idempotent when the indexes already exist (ensureIndex returns false)", async () => {
    const store = createMockStore();
    store.ensureIndex = vi.fn().mockResolvedValue(false);
    const migration = new SchemaV14EnrichmentScanIndexes(COLLECTION, store);

    const result = await migration.apply();

    expect(store.ensureIndex).toHaveBeenCalledTimes(ENRICHMENT_SCAN_INDEXES.length);
    expect(result.applied).toHaveLength(ENRICHMENT_SCAN_INDEXES.length);
  });
});

/**
 * The index list is MIRRORED in the adapter layer — it cannot import the
 * enrichment domain — so nothing but this test keeps it honest. A provider key
 * added, a level renamed, or a third terminal state introduced silently drops
 * the filter back to a full payload scan, with no failure anywhere.
 */
describe("ENRICHMENT_SCAN_INDEXES covers the unenriched filter", () => {
  function collectFilterKeys(node: unknown, into: Set<string>): void {
    if (Array.isArray(node)) {
      for (const item of node) collectFilterKeys(item, into);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (typeof record.key === "string") into.add(record.key);
    for (const value of Object.values(record)) collectFilterKeys(value, into);
  }

  it.each(["git", "codegraph.symbols"])("declares an index for every key %s's filter references", async (key) => {
    const countPoints = vi.fn().mockResolvedValue(0);
    const recovery = new EnrichmentRecovery(
      { scrollFiltered: vi.fn().mockResolvedValue([]), batchSetPayload: vi.fn(), countPoints } as never,
      { applyFileSignals: vi.fn(), applyChunkSignals: vi.fn() } as never,
    );
    const indexed = new Set(ENRICHMENT_SCAN_INDEXES.map(({ path }) => path));

    for (const level of ["file", "chunk"] as const) {
      // No `shouldEnrich` ⇒ the server-side count path, which hands the raw
      // filter straight to Qdrant.
      await recovery.countUnenriched("test_col", { key } as never, level);
      const [, filter] = countPoints.mock.calls.at(-1) as [string, Record<string, unknown>];
      const keys = new Set<string>();
      collectFilterKeys(filter, keys);

      expect(keys.size).toBeGreaterThan(0);
      for (const filterKey of keys) {
        // relativePath is indexed by schema-v4/v5, everything else by v14.
        if (filterKey === "relativePath") continue;
        expect(indexed).toContain(filterKey);
      }
    }
  });
});
