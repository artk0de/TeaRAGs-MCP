import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import {
  cleanupOrphanedVersions,
  sweepCodegraphOrphans,
} from "../../../../../src/core/domains/ingest/infra/alias-cleanup.js";

function createMockQdrant(aliases: { aliasName: string; collectionName: string }[], collections: string[]) {
  return {
    aliases: {
      listAliases: vi.fn().mockResolvedValue(aliases),
    },
    listCollections: vi.fn().mockResolvedValue(collections),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantManager;
}

describe("cleanupOrphanedVersions", () => {
  it("deletes versioned collections not pointed to by alias", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(2);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v3");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("code_abc_v2");
  });

  it("does nothing when no orphans exist", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it("does nothing when alias not found", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "other_collection", collectionName: "other_collection_v1" }],
      ["code_abc_v1", "code_abc_v2"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(0);
    expect(qdrant.deleteCollection).not.toHaveBeenCalled();
  });

  it("does not delete unrelated collections", async () => {
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v1", "code_abc_v2", "other_collection", "another_v1"],
    );

    const result = await cleanupOrphanedVersions(qdrant, "code_abc");

    expect(result).toBe(1);
    expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("other_collection");
    expect(qdrant.deleteCollection).not.toHaveBeenCalledWith("another_v1");
  });

  describe("codegraph DB cleanup", () => {
    it("removes the codegraph DB for each deleted orphan", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
        ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
      );
      const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

      const result = await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(result).toBe(2);
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v3");
      expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v2");
    });

    it("does not call the codegraph remover when there are no orphans", async () => {
      const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);
      const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

      await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(removeCodegraphDb).not.toHaveBeenCalled();
    });

    it("treats a codegraph remover failure as non-fatal and keeps deleting other orphans", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v3" }],
        ["code_abc_v1", "code_abc_v2", "code_abc_v3"],
      );
      const removeCodegraphDb = vi.fn().mockRejectedValueOnce(new Error("unlink failed")).mockResolvedValue(undefined);

      const result = await cleanupOrphanedVersions(qdrant, "code_abc", removeCodegraphDb);

      expect(result).toBe(2);
      // Both orphan Qdrant collections still deleted despite the first remover throwing.
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v2");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
      expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v2");
    });

    it("works without a codegraph remover (backwards compatible)", async () => {
      const qdrant = createMockQdrant(
        [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
        ["code_abc_v1", "code_abc_v2"],
      );

      const result = await cleanupOrphanedVersions(qdrant, "code_abc");

      expect(result).toBe(1);
      expect(qdrant.deleteCollection).toHaveBeenCalledWith("code_abc_v1");
    });
  });
});

describe("sweepCodegraphOrphans", () => {
  it("removes codegraph DBs whose Qdrant collection is absent, skipping the active alias target", async () => {
    // Codegraph dir holds DBs for v1 (ancient orphan — no Qdrant collection),
    // v2 (active alias target), and v3 (still has a Qdrant collection).
    const qdrant = createMockQdrant(
      [{ aliasName: "code_abc", collectionName: "code_abc_v2" }],
      ["code_abc_v2", "code_abc_v3"],
    );
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v1", "code_abc_v2", "code_abc_v3"]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(1);
    expect(listCodegraphDbs).toHaveBeenCalledWith("code_abc");
    // v1 has no Qdrant collection and is not the active target → removed.
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
    // v2 is the active alias target → never removed even though it has a DB.
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v2");
    // v3 still has a live Qdrant collection → never removed.
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v3");
  });

  it("never removes the active alias target even when its Qdrant collection is missing from listCollections", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], []);
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v2"]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(0);
    expect(removeCodegraphDb).not.toHaveBeenCalled();
  });

  it("is a no-op when the lister returns no codegraph DBs", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v2" }], ["code_abc_v2"]);
    const listCodegraphDbs = vi.fn().mockReturnValue([]);
    const removeCodegraphDb = vi.fn().mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    expect(removed).toBe(0);
    expect(removeCodegraphDb).not.toHaveBeenCalled();
  });

  it("treats a remover failure as non-fatal and keeps sweeping other orphans", async () => {
    const qdrant = createMockQdrant([{ aliasName: "code_abc", collectionName: "code_abc_v3" }], ["code_abc_v3"]);
    const listCodegraphDbs = vi.fn().mockReturnValue(["code_abc_v1", "code_abc_v2", "code_abc_v3"]);
    const removeCodegraphDb = vi.fn().mockRejectedValueOnce(new Error("unlink failed")).mockResolvedValue(undefined);

    const removed = await sweepCodegraphOrphans(qdrant, "code_abc", listCodegraphDbs, removeCodegraphDb);

    // Both v1 and v2 are orphan codegraph DBs; the first remover throws but the
    // second still runs. The counter reflects successful removals only.
    expect(removed).toBe(1);
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v1");
    expect(removeCodegraphDb).toHaveBeenCalledWith("code_abc_v2");
    expect(removeCodegraphDb).not.toHaveBeenCalledWith("code_abc_v3");
  });
});
