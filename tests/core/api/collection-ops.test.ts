import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { CollectionOps } from "../../../src/core/api/internal/ops/collection-ops.js";

function createMockQdrant(): QdrantManager {
  return {
    createCollection: vi.fn().mockResolvedValue(undefined),
    listCollections: vi.fn().mockResolvedValue(["col1", "col2"]),
    getCollectionInfo: vi.fn().mockResolvedValue({
      name: "test",
      vectorSize: 384,
      pointsCount: 42,
      distance: "Cosine",
      hybridEnabled: false,
    }),
    deleteCollection: vi.fn().mockResolvedValue(undefined),
    collectionExists: vi.fn().mockResolvedValue(true),
  } as unknown as QdrantManager;
}

function createMockEmbeddings(dimensions = 384): EmbeddingProvider {
  return {
    getDimensions: vi.fn().mockReturnValue(dimensions),
    getModel: vi.fn().mockReturnValue("test-model"),
    embed: vi.fn(),
    embedBatch: vi.fn(),
  } as unknown as EmbeddingProvider;
}

describe("CollectionOps", () => {
  let qdrant: QdrantManager;
  let embeddings: EmbeddingProvider;
  let ops: CollectionOps;

  beforeEach(() => {
    qdrant = createMockQdrant();
    embeddings = createMockEmbeddings();
    ops = new CollectionOps(qdrant, embeddings, false);
  });

  describe("create", () => {
    it("creates collection with embedding dimensions", async () => {
      const result = await ops.create({ name: "my-col" });

      expect(qdrant.createCollection).toHaveBeenCalledWith("my-col", 384, undefined, false, false);
      expect(result).toEqual({
        name: "my-col",
        vectorSize: 384,
        pointsCount: 0,
        distance: "Cosine",
        hybridEnabled: false,
      });
    });

    it("passes distance metric when provided", async () => {
      const result = await ops.create({ name: "my-col", distance: "Dot" });

      expect(qdrant.createCollection).toHaveBeenCalledWith("my-col", 384, "Dot", false, false);
      expect(result.distance).toBe("Dot");
    });

    it("passes enableHybrid flag", async () => {
      const result = await ops.create({ name: "my-col", enableHybrid: true });

      expect(qdrant.createCollection).toHaveBeenCalledWith("my-col", 384, undefined, true, false);
      expect(result.hybridEnabled).toBe(true);
    });

    it("uses embedding provider dimensions", async () => {
      embeddings = createMockEmbeddings(768);
      ops = new CollectionOps(qdrant, embeddings, false);

      const result = await ops.create({ name: "my-col" });

      expect(qdrant.createCollection).toHaveBeenCalledWith("my-col", 768, undefined, false, false);
      expect(result.vectorSize).toBe(768);
    });

    it("passes quantizationScalar to qdrant.createCollection", async () => {
      ops = new CollectionOps(qdrant, embeddings, true);
      await ops.create({ name: "my-col" });

      expect(qdrant.createCollection).toHaveBeenCalledWith("my-col", 384, undefined, false, true);
    });
  });

  describe("list", () => {
    it("delegates to qdrant.listCollections", async () => {
      const result = await ops.list();

      expect(qdrant.listCollections).toHaveBeenCalled();
      expect(result).toEqual(["col1", "col2"]);
    });
  });

  describe("getInfo", () => {
    it("delegates to qdrant.getCollectionInfo", async () => {
      const result = await ops.getInfo("test");

      expect(qdrant.getCollectionInfo).toHaveBeenCalledWith("test");
      expect(result).toEqual({
        name: "test",
        vectorSize: 384,
        pointsCount: 42,
        distance: "Cosine",
        hybridEnabled: false,
      });
    });
  });

  describe("delete", () => {
    it("delegates to qdrant.deleteCollection", async () => {
      await ops.delete("test");

      expect(qdrant.deleteCollection).toHaveBeenCalledWith("test");
    });
  });
});
