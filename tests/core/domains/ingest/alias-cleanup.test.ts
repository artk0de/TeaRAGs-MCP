import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { cleanupOrphanedVersions } from "../../../../src/core/domains/ingest/alias-cleanup.js";

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
});
