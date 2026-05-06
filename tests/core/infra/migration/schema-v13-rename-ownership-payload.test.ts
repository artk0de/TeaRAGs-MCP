import { describe, expect, it, vi } from "vitest";

import { SchemaV13RenameOwnershipPayload } from "../../../../src/core/infra/migration/schema_migrations/schema-v13-rename-ownership-payload.js";

const COLLECTION = "test_col";

function createV13Store() {
  return {
    getSchemaVersion: vi.fn().mockResolvedValue(12),
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

describe("SchemaV13RenameOwnershipPayload", () => {
  it("renames legacy commit-based keys (file + chunk) to recent* prefix", async () => {
    const store = createV13Store();
    store.scrollAllPayload.mockResolvedValue([
      {
        id: "p1",
        payload: {
          git: {
            file: { dominantAuthor: "Alice", authors: ["Alice", "Bob"], contributorCount: 2 },
            chunk: { contributorCount: 1 },
          },
        },
      },
      {
        id: "p2",
        payload: {
          git: { file: { dominantAuthorPct: 80, dominantAuthorEmail: "alice@x" } },
        },
      },
      // Already migrated — new key present, must be skipped
      {
        id: "p3",
        payload: {
          git: { file: { recentDominantAuthor: "Carol", dominantAuthor: "stale" } },
        },
      },
      // No git data — must be skipped
      { id: "p4", payload: { relativePath: "x.ts" } },
    ]);

    const migration = new SchemaV13RenameOwnershipPayload(COLLECTION, store);
    const result = await migration.apply();

    // Three points needed renames (p1, p2, p3 had stale dominantAuthor but was overshadowed by existing recent)
    // p3 has dominantAuthor=stale but recentDominantAuthor already set — that key skipped.
    // Verify batchSetPayload called with correct dot-key payloads
    const batchedOps = store.batchSetPayload.mock.calls[0]?.[1] as {
      points: string[];
      payload: Record<string, unknown>;
    }[];
    expect(batchedOps).toBeDefined();

    const p1Op = batchedOps.find((o) => o.points[0] === "p1");
    expect(p1Op?.payload).toEqual({
      "git.file.recentDominantAuthor": "Alice",
      "git.file.recentAuthors": ["Alice", "Bob"],
      "git.file.recentContributorCount": 2,
      "git.chunk.recentContributorCount": 1,
    });

    const p2Op = batchedOps.find((o) => o.points[0] === "p2");
    expect(p2Op?.payload).toEqual({
      "git.file.recentDominantAuthorPct": 80,
      "git.file.recentDominantAuthorEmail": "alice@x",
    });

    const p3Op = batchedOps.find((o) => o.points[0] === "p3");
    expect(p3Op).toBeUndefined();

    expect(store.deletePayloadKeys).toHaveBeenCalledWith(
      COLLECTION,
      expect.arrayContaining([
        "git.file.dominantAuthor",
        "git.file.dominantAuthorEmail",
        "git.file.dominantAuthorPct",
        "git.file.authors",
        "git.file.contributorCount",
        "git.chunk.contributorCount",
      ]),
    );

    expect(result.applied[0]).toMatch(/renamed ownership keys on 2 points/);
  });

  it("skips batch when no points need rename (idempotent re-run)", async () => {
    const store = createV13Store();
    store.scrollAllPayload.mockResolvedValue([
      { id: "p1", payload: { git: { file: { recentDominantAuthor: "Alice" } } } },
    ]);

    const migration = new SchemaV13RenameOwnershipPayload(COLLECTION, store);
    const result = await migration.apply();

    expect(store.batchSetPayload).not.toHaveBeenCalled();
    expect(result.applied).toContain("no points needed rename — skip");
    // Old keys still get deleted (idempotent — Qdrant handles missing keys gracefully)
    expect(store.deletePayloadKeys).toHaveBeenCalled();
  });

  it("returns early on empty collection", async () => {
    const store = createV13Store();
    store.scrollAllPayload.mockResolvedValue([]);

    const migration = new SchemaV13RenameOwnershipPayload(COLLECTION, store);
    const result = await migration.apply();

    expect(store.batchSetPayload).not.toHaveBeenCalled();
    expect(store.deletePayloadKeys).not.toHaveBeenCalled();
    expect(result.applied).toEqual(["no points to migrate"]);
  });
});
