import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { DocumentOps } from "../../../src/core/api/internal/ops/document-ops.js";

function createMockQdrant(overrides: Partial<QdrantManager> = {}): QdrantManager {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({
      name: "test",
      vectorSize: 384,
      pointsCount: 10,
      distance: "Cosine",
      hybridEnabled: false,
    }),
    addPoints: vi.fn().mockResolvedValue(undefined),
    addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
    deletePoints: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as QdrantManager;
}

function createMockEmbeddings(): EmbeddingProvider {
  return {
    getDimensions: vi.fn().mockReturnValue(384),
    getModel: vi.fn().mockReturnValue("test-model"),
    embed: vi.fn(),
    embedBatch: vi.fn().mockResolvedValue([
      { embedding: [0.1, 0.2, 0.3], dimensions: 384 },
      { embedding: [0.4, 0.5, 0.6], dimensions: 384 },
    ]),
  } as unknown as EmbeddingProvider;
}

describe("DocumentOps", () => {
  let qdrant: QdrantManager;
  let embeddings: EmbeddingProvider;
  let ops: DocumentOps;

  beforeEach(() => {
    qdrant = createMockQdrant();
    embeddings = createMockEmbeddings();
    ops = new DocumentOps(qdrant, embeddings);
  });

  describe("add", () => {
    const request = {
      collection: "test",
      documents: [
        { id: "doc1", text: "hello world" },
        { id: "doc2", text: "foo bar", metadata: { category: "test" } },
      ],
    };

    it("throws when collection does not exist", async () => {
      qdrant = createMockQdrant({ collectionExists: vi.fn().mockResolvedValue(false) });
      ops = new DocumentOps(qdrant, embeddings);

      await expect(ops.add(request)).rejects.toThrow('Collection "test" not found');
    });

    it("embeds all document texts", async () => {
      await ops.add(request);

      expect(embeddings.embedBatch).toHaveBeenCalledWith(["hello world", "foo bar"]);
    });

    it("adds points to non-hybrid collection", async () => {
      await ops.add(request);

      expect(qdrant.addPoints).toHaveBeenCalledWith("test", [
        { id: "doc1", vector: [0.1, 0.2, 0.3], payload: { text: "hello world" } },
        { id: "doc2", vector: [0.4, 0.5, 0.6], payload: { text: "foo bar", category: "test" } },
      ]);
      expect(qdrant.addPointsWithSparse).not.toHaveBeenCalled();
    });

    it("adds points with sparse vectors to hybrid collection", async () => {
      qdrant = createMockQdrant({
        getCollectionInfo: vi.fn().mockResolvedValue({
          name: "test",
          vectorSize: 384,
          pointsCount: 10,
          distance: "Cosine",
          hybridEnabled: true,
        }),
      });
      ops = new DocumentOps(qdrant, embeddings);

      await ops.add(request);

      expect(qdrant.addPointsWithSparse).toHaveBeenCalledTimes(1);
      expect(qdrant.addPoints).not.toHaveBeenCalled();

      // Verify the points have sparseVector field
      const call = vi.mocked(qdrant.addPointsWithSparse).mock.calls[0];
      expect(call[0]).toBe("test");
      expect(call[1]).toHaveLength(2);
      expect(call[1][0]).toHaveProperty("sparseVector");
      expect(call[1][0].sparseVector).toHaveProperty("indices");
      expect(call[1][0].sparseVector).toHaveProperty("values");
    });

    it("returns document count", async () => {
      const result = await ops.add(request);

      expect(result).toEqual({ count: 2 });
    });
  });

  describe("delete", () => {
    it("delegates to qdrant.deletePoints", async () => {
      const result = await ops.delete({ collection: "test", ids: ["id1", "id2"] });

      expect(qdrant.deletePoints).toHaveBeenCalledWith("test", ["id1", "id2"]);
      expect(result).toEqual({ count: 2 });
    });
  });
});
