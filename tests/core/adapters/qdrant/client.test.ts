import { QdrantClient } from "@qdrant/js-client-rest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantAliasManager } from "../../../../src/core/adapters/qdrant/aliases.js";
import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { QdrantOperationError } from "../../../../src/core/adapters/qdrant/errors.js";

const mockClient = {
  createCollection: vi.fn().mockResolvedValue({}),
  getCollection: vi.fn().mockResolvedValue({}),
  getCollections: vi.fn().mockResolvedValue({ collections: [] }),
  deleteCollection: vi.fn().mockResolvedValue({}),
  upsert: vi.fn().mockResolvedValue({}),
  search: vi.fn().mockResolvedValue([]),
  retrieve: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue({}),
  query: vi.fn().mockResolvedValue({ points: [] }),
  createPayloadIndex: vi.fn().mockResolvedValue({}),
  updateCollection: vi.fn().mockResolvedValue({}),
  setPayload: vi.fn().mockResolvedValue({}),
  batchUpdate: vi.fn().mockResolvedValue({}),
  scroll: vi.fn().mockResolvedValue({ points: [] }),
  queryGroups: vi.fn().mockResolvedValue({ groups: [] }),
  count: vi.fn().mockResolvedValue({ count: 0 }),
};

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

describe("QdrantManager", () => {
  let manager: QdrantManager;

  beforeEach(() => {
    // Reset mocks and restore default implementations
    mockClient.createCollection.mockReset().mockResolvedValue({});
    mockClient.getCollection.mockReset().mockResolvedValue({});
    mockClient.getCollections.mockReset().mockResolvedValue({ collections: [] });
    mockClient.deleteCollection.mockReset().mockResolvedValue({});
    mockClient.upsert.mockReset().mockResolvedValue({});
    mockClient.search.mockReset().mockResolvedValue([]);
    mockClient.retrieve.mockReset().mockResolvedValue([]);
    mockClient.delete.mockReset().mockResolvedValue({});
    mockClient.query.mockReset().mockResolvedValue({ points: [] });
    mockClient.createPayloadIndex.mockReset().mockResolvedValue({});
    mockClient.updateCollection.mockReset().mockResolvedValue({});
    mockClient.setPayload.mockReset().mockResolvedValue({});
    mockClient.batchUpdate.mockReset().mockResolvedValue({});
    mockClient.queryGroups.mockReset().mockResolvedValue({ groups: [] });
    mockClient.scroll.mockReset().mockResolvedValue({ points: [], next_page_offset: null });
    vi.mocked(QdrantClient).mockClear();
    manager = new QdrantManager("http://localhost:6333");
  });

  describe("aliases", () => {
    it("returns a QdrantAliasManager instance", () => {
      expect(manager.aliases).toBeInstanceOf(QdrantAliasManager);
    });

    it("returns the same instance on repeated access", () => {
      expect(manager.aliases).toBe(manager.aliases);
    });
  });

  describe("url", () => {
    it("returns the Qdrant URL passed to constructor", () => {
      expect(manager.url).toBe("http://localhost:6333");
    });
  });

  describe("constructor", () => {
    it("should pass apiKey to QdrantClient when provided", () => {
      new QdrantManager("http://localhost:6333", "test-api-key");

      expect(QdrantClient).toHaveBeenCalledWith({
        url: "http://localhost:6333",
        apiKey: "test-api-key",
      });
    });

    it("should work without apiKey for unauthenticated instances", () => {
      new QdrantManager("http://localhost:6333");

      expect(QdrantClient).toHaveBeenCalledWith({
        url: "http://localhost:6333",
        apiKey: undefined,
      });
    });
  });

  describe("createCollection", () => {
    it("should create a collection with default distance metric", async () => {
      await manager.createCollection("test-collection", 1536);

      expect(mockClient.createCollection).toHaveBeenCalledWith("test-collection", {
        vectors: {
          size: 1536,
          distance: "Cosine",
        },
      });
    });

    it("should create a collection with custom distance metric", async () => {
      await manager.createCollection("test-collection", 1536, "Euclid");

      expect(mockClient.createCollection).toHaveBeenCalledWith("test-collection", {
        vectors: {
          size: 1536,
          distance: "Euclid",
        },
      });
    });

    it("should create a hybrid collection with sparse vectors enabled", async () => {
      await manager.createCollection("test-collection", 1536, "Cosine", true);

      expect(mockClient.createCollection).toHaveBeenCalledWith("test-collection", {
        vectors: {
          dense: {
            size: 1536,
            distance: "Cosine",
          },
        },
        sparse_vectors: {
          text: {
            modifier: "idf",
          },
        },
      });
    });

    it("should create collection with quantization when scalar flag is true", async () => {
      await manager.createCollection("test-collection", 384, "Cosine", false, true);

      expect(mockClient.createCollection).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          quantization_config: { scalar: { type: "int8", always_ram: true } },
        }),
      );
    });

    it("should throw CollectionAlreadyExistsError on 409 Conflict", async () => {
      const conflictError = Object.assign(new Error("Conflict"), { status: 409 });
      mockClient.createCollection.mockRejectedValue(conflictError);

      const { CollectionAlreadyExistsError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      await expect(manager.createCollection("existing", 384)).rejects.toThrow(CollectionAlreadyExistsError);
    });

    it("should throw CollectionAlreadyExistsError when error message contains 'already exists'", async () => {
      mockClient.createCollection.mockRejectedValue(new Error("Collection already exists"));

      const { CollectionAlreadyExistsError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      await expect(manager.createCollection("existing", 384)).rejects.toThrow(CollectionAlreadyExistsError);
    });

    it("should rethrow non-conflict errors from createCollection", async () => {
      const error = Object.assign(new Error("Internal server error"), { status: 500 });
      mockClient.createCollection.mockRejectedValue(error);

      await expect(manager.createCollection("test", 384)).rejects.toThrow("Internal server error");
    });

    it("should throw QdrantUnavailableError on connection failure", async () => {
      mockClient.createCollection.mockRejectedValue(new Error("fetch failed"));

      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      await expect(manager.createCollection("test", 384)).rejects.toThrow(QdrantUnavailableError);
    });
  });

  describe("collectionExists", () => {
    it("should return true if collection exists", async () => {
      mockClient.getCollection.mockResolvedValue({ collection_name: "test" });

      const exists = await manager.collectionExists("test");

      expect(exists).toBe(true);
      expect(mockClient.getCollection).toHaveBeenCalledWith("test");
    });

    it("should return false if collection does not exist (404)", async () => {
      const notFoundError = Object.assign(new Error("Not found"), { status: 404 });
      mockClient.getCollection.mockRejectedValue(notFoundError);

      const exists = await manager.collectionExists("test");

      expect(exists).toBe(false);
    });

    it("should throw QdrantUnavailableError on connection failure", async () => {
      mockClient.getCollection.mockRejectedValue(new Error("fetch failed"));

      await expect(manager.collectionExists("test")).rejects.toThrow("Qdrant is not reachable");
    });

    it("should rethrow non-connection non-404 errors", async () => {
      const serverError = Object.assign(new Error("Internal server error"), { status: 500 });
      mockClient.getCollection.mockRejectedValue(serverError);

      await expect(manager.collectionExists("test")).rejects.toThrow("Internal server error");
    });
  });

  describe("listCollections", () => {
    it("should return list of collection names", async () => {
      mockClient.getCollections.mockResolvedValue({
        collections: [{ name: "collection1" }, { name: "collection2" }, { name: "collection3" }],
      });

      const collections = await manager.listCollections();

      expect(collections).toEqual(["collection1", "collection2", "collection3"]);
    });

    it("should return empty array when no collections exist", async () => {
      mockClient.getCollections.mockResolvedValue({
        collections: [],
      });

      const collections = await manager.listCollections();

      expect(collections).toEqual([]);
    });
  });

  describe("getCollectionInfo", () => {
    it("should return collection info with vector configuration", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        points_count: 100,
        config: {
          params: {
            vectors: {
              size: 1536,
              distance: "Cosine",
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("test-collection");

      expect(info).toEqual({
        name: "test-collection",
        vectorSize: 1536,
        pointsCount: 100,
        distance: "Cosine",
        hybridEnabled: false,
      });
    });

    it("should handle missing points_count", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        config: {
          params: {
            vectors: {
              size: 1536,
              distance: "Dot",
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("test-collection");

      expect(info.pointsCount).toBe(0);
    });

    it("should return hybrid collection info with named vectors", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "hybrid-collection",
        points_count: 50,
        config: {
          params: {
            vectors: {
              dense: {
                size: 768,
                distance: "Cosine",
              },
            },
            sparse_vectors: {
              text: {
                modifier: "idf",
              },
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("hybrid-collection");

      expect(info).toEqual({
        name: "hybrid-collection",
        vectorSize: 768,
        pointsCount: 50,
        distance: "Cosine",
        hybridEnabled: true,
      });
    });

    it("should handle null/non-object vectorConfig gracefully", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "no-vectors",
        points_count: 0,
        config: {
          params: {
            vectors: null,
          },
        },
      });

      const info = await manager.getCollectionInfo("no-vectors");

      expect(info).toEqual({
        name: "no-vectors",
        vectorSize: 0,
        pointsCount: 0,
        distance: "Cosine",
        hybridEnabled: false,
      });
    });

    it("should handle named vector config with non-number size", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "bad-dense",
        points_count: 10,
        config: {
          params: {
            vectors: {
              dense: {
                size: "not-a-number",
                distance: "Euclid",
              },
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("bad-dense");

      expect(info).toEqual({
        name: "bad-dense",
        vectorSize: 0,
        pointsCount: 10,
        distance: "Euclid",
        hybridEnabled: false,
      });
    });

    it("should handle unnamed vector config with non-number size", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "bad-unnamed",
        points_count: 5,
        config: {
          params: {
            vectors: {
              size: "invalid",
              distance: "Dot",
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("bad-unnamed");

      expect(info).toEqual({
        name: "bad-unnamed",
        vectorSize: 0,
        pointsCount: 5,
        distance: "Dot",
        hybridEnabled: false,
      });
    });

    it("should handle vectorConfig object with neither size nor dense keys", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "unknown-config",
        points_count: 3,
        config: {
          params: {
            vectors: {
              someOtherKey: { size: 512 },
            },
          },
        },
      });

      const info = await manager.getCollectionInfo("unknown-config");

      expect(info).toEqual({
        name: "unknown-config",
        vectorSize: 0,
        pointsCount: 3,
        distance: "Cosine",
        hybridEnabled: false,
      });
    });
  });

  describe("deleteCollection", () => {
    it("should delete a collection", async () => {
      await manager.deleteCollection("test-collection");

      expect(mockClient.deleteCollection).toHaveBeenCalledWith("test-collection");
    });
  });

  describe("addPoints", () => {
    it("should add points to a collection", async () => {
      const points = [
        { id: 1, vector: [0.1, 0.2, 0.3], payload: { text: "test" } },
        { id: 2, vector: [0.4, 0.5, 0.6], payload: { text: "test2" } },
      ];

      await manager.addPoints("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points,
      });
    });

    it("should add points without payload", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      await manager.addPoints("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points,
      });
    });

    it("should normalize string IDs to UUID format", async () => {
      const points = [
        {
          id: "my-custom-id",
          vector: [0.1, 0.2, 0.3],
          payload: { text: "test" },
        },
      ];

      await manager.addPoints("test-collection", points);

      // Verify the ID was normalized to UUID format
      const { calls } = mockClient.upsert.mock;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("test-collection");

      const normalizedId = calls[0][1].points[0].id;
      // Check that it's a valid UUID format
      expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      // Ensure it's not the original ID
      expect(normalizedId).not.toBe("my-custom-id");
    });

    it("should preserve UUID format IDs without modification", async () => {
      const uuidId = "123e4567-e89b-12d3-a456-426614174000";
      const points = [{ id: uuidId, vector: [0.1, 0.2, 0.3], payload: { text: "test" } }];

      await manager.addPoints("test-collection", points);

      // UUID should remain unchanged
      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: [
          {
            id: uuidId,
            vector: [0.1, 0.2, 0.3],
            payload: { text: "test" },
          },
        ],
      });
    });

    it("should throw error with error.data.status.error message", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue({
        data: {
          status: {
            error: "Vector dimension mismatch",
          },
        },
      });

      await expect(manager.addPoints("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw error with error.message fallback", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      const error = Object.assign(new Error("Payload validation failed"), { status: 422 });
      mockClient.upsert.mockRejectedValue(error);

      await expect(manager.addPoints("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw QdrantUnavailableError on connection failure", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue(new Error("fetch failed"));

      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      await expect(manager.addPoints("test-collection", points)).rejects.toThrow(QdrantUnavailableError);
    });

    it("should throw error with String(error) fallback", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue("Unknown error");

      await expect(manager.addPoints("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should handle empty points array gracefully", async () => {
      await manager.addPoints("test-collection", []);

      // Should not call upsert for empty arrays
      expect(mockClient.upsert).not.toHaveBeenCalled();
    });
  });

  describe("addPointsOptimized", () => {
    it("should add points with optimized settings", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3], payload: { text: "test" } }];

      await manager.addPointsOptimized("test-collection", points, {
        wait: false,
        ordering: "weak",
      });

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: false,
        ordering: "weak",
        points: [{ id: 1, vector: [0.1, 0.2, 0.3], payload: { text: "test" } }],
      });
    });

    it("should use default options when not provided", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      await manager.addPointsOptimized("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: false,
        ordering: "weak",
        points: expect.any(Array),
      });
    });

    it("should handle empty points array gracefully", async () => {
      await manager.addPointsOptimized("test-collection", []);

      // Should not call upsert for empty arrays
      expect(mockClient.upsert).not.toHaveBeenCalled();
    });

    it("should normalize string IDs to UUID format", async () => {
      const points = [{ id: "my-optimized-id", vector: [0.1, 0.2, 0.3], payload: { text: "test" } }];

      await manager.addPointsOptimized("test-collection", points);

      const { calls } = mockClient.upsert.mock;
      expect(calls).toHaveLength(1);

      const normalizedId = calls[0][1].points[0].id;
      expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(normalizedId).not.toBe("my-optimized-id");
    });

    it("should throw error with error.data.status.error message", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue({
        data: {
          status: {
            error: "Dimension mismatch",
          },
        },
      });

      await expect(manager.addPointsOptimized("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw error with error.message fallback", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue(new Error("Connection lost"));

      await expect(manager.addPointsOptimized("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw error with String(error) fallback", async () => {
      const points = [{ id: 1, vector: [0.1, 0.2, 0.3] }];

      mockClient.upsert.mockRejectedValue("Server error");

      await expect(manager.addPointsOptimized("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });
  });

  describe("disableIndexing and enableIndexing", () => {
    beforeEach(() => {
      mockClient.updateCollection = vi.fn().mockResolvedValue({});
    });

    it("should disable indexing for bulk upload", async () => {
      await manager.disableIndexing("test-collection");

      expect(mockClient.updateCollection).toHaveBeenCalledWith("test-collection", {
        optimizers_config: {
          indexing_threshold: 0,
        },
      });
    });

    it("should enable indexing with default threshold", async () => {
      await manager.enableIndexing("test-collection");

      expect(mockClient.updateCollection).toHaveBeenCalledWith("test-collection", {
        optimizers_config: {
          indexing_threshold: 20000,
        },
      });
    });

    it("should enable indexing with custom threshold", async () => {
      await manager.enableIndexing("test-collection", 50000);

      expect(mockClient.updateCollection).toHaveBeenCalledWith("test-collection", {
        optimizers_config: {
          indexing_threshold: 50000,
        },
      });
    });
  });

  describe("search", () => {
    beforeEach(() => {
      // Mock getCollection for standard collection by default
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        points_count: 100,
        config: {
          params: {
            vectors: {
              size: 768,
              distance: "Cosine",
            },
          },
        },
      });
    });

    it("should search for similar vectors", async () => {
      mockClient.search.mockResolvedValue([
        { id: 1, score: 0.95, payload: { text: "result1" } },
        { id: 2, score: 0.85, payload: { text: "result2" } },
      ]);

      const results = await manager.search("test-collection", [0.1, 0.2, 0.3], 5);

      expect(results).toEqual([
        { id: 1, score: 0.95, payload: { text: "result1" } },
        { id: 2, score: 0.85, payload: { text: "result2" } },
      ]);
      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter: undefined,
        with_payload: true,
      });
    });

    it("should search with custom limit", async () => {
      mockClient.search.mockResolvedValue([]);

      await manager.search("test-collection", [0.1, 0.2, 0.3], 10);

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        filter: undefined,
        with_payload: true,
      });
    });

    it("should search with Qdrant format filter (must)", async () => {
      mockClient.search.mockResolvedValue([]);

      const filter = { must: [{ key: "category", match: { value: "test" } }] };
      await manager.search("test-collection", [0.1, 0.2, 0.3], 5, filter);

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter,
        with_payload: true,
      });
    });

    it("should convert simple key-value filter to Qdrant format", async () => {
      mockClient.search.mockResolvedValue([]);

      const simpleFilter = { category: "database", type: "document" };
      await manager.search("test-collection", [0.1, 0.2, 0.3], 5, simpleFilter);

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter: {
          must: [
            { key: "category", match: { value: "database" } },
            { key: "type", match: { value: "document" } },
          ],
        },
        with_payload: true,
      });
    });

    it("should handle empty filter object", async () => {
      mockClient.search.mockResolvedValue([]);

      await manager.search("test-collection", [0.1, 0.2, 0.3], 5, {});

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter: undefined,
        with_payload: true,
      });
    });

    it("should search with Qdrant format filter (should)", async () => {
      mockClient.search.mockResolvedValue([]);

      const filter = {
        should: [{ key: "tag", match: { value: "important" } }],
      };
      await manager.search("test-collection", [0.1, 0.2, 0.3], 5, filter);

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter,
        with_payload: true,
      });
    });

    it("should search with Qdrant format filter (must_not)", async () => {
      mockClient.search.mockResolvedValue([]);

      const filter = {
        must_not: [{ key: "status", match: { value: "deleted" } }],
      };
      await manager.search("test-collection", [0.1, 0.2, 0.3], 5, filter);

      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter,
        with_payload: true,
      });
    });

    it("should handle null payload in results", async () => {
      mockClient.search.mockResolvedValue([{ id: 1, score: 0.95, payload: null }]);

      const results = await manager.search("test-collection", [0.1, 0.2, 0.3]);

      expect(results).toEqual([{ id: 1, score: 0.95, payload: undefined }]);
    });

    it("should use named vector for hybrid-enabled collections", async () => {
      // Mock getCollectionInfo to return hybrid enabled collection
      mockClient.getCollection.mockResolvedValue({
        collection_name: "hybrid-collection",
        points_count: 10,
        config: {
          params: {
            vectors: {
              dense: {
                size: 768,
                distance: "Cosine",
              },
            },
            sparse_vectors: {
              text: {
                modifier: "idf",
              },
            },
          },
        },
      });

      mockClient.search.mockResolvedValue([{ id: 1, score: 0.95, payload: { text: "result1" } }]);

      const results = await manager.search("hybrid-collection", [0.1, 0.2, 0.3], 5);

      expect(results).toEqual([{ id: 1, score: 0.95, payload: { text: "result1" } }]);
      expect(mockClient.search).toHaveBeenCalledWith("hybrid-collection", {
        vector: { name: "dense", vector: [0.1, 0.2, 0.3] },
        limit: 5,
        filter: undefined,
        with_payload: true,
      });
    });

    it("should use unnamed vector for standard collections", async () => {
      // Mock getCollectionInfo to return standard collection (no sparse vectors)
      mockClient.getCollection.mockResolvedValue({
        collection_name: "standard-collection",
        points_count: 10,
        config: {
          params: {
            vectors: {
              size: 768,
              distance: "Cosine",
            },
          },
        },
      });

      mockClient.search.mockResolvedValue([{ id: 1, score: 0.95, payload: { text: "result1" } }]);

      const results = await manager.search("standard-collection", [0.1, 0.2, 0.3], 5);

      expect(results).toEqual([{ id: 1, score: 0.95, payload: { text: "result1" } }]);
      expect(mockClient.search).toHaveBeenCalledWith("standard-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 5,
        filter: undefined,
        with_payload: true,
      });
    });

    it("should search with complex filters and return matching results", async () => {
      mockClient.search.mockResolvedValue([{ id: "1", score: 0.95, payload: { category: "test", priority: 1 } }]);

      const results = await manager.search("test-collection", [0.1, 0.2, 0.3], 10, {
        must: [{ key: "category", match: { value: "test" } }],
      });

      expect(results.length).toBe(1);
      expect(results[0].id).toBe("1");
      expect(results[0].payload).toEqual({ category: "test", priority: 1 });
      expect(mockClient.search).toHaveBeenCalledWith("test-collection", {
        vector: [0.1, 0.2, 0.3],
        limit: 10,
        filter: {
          must: [{ key: "category", match: { value: "test" } }],
        },
        with_payload: true,
      });
    });
  });

  describe("getPoint", () => {
    it("should retrieve a point by id", async () => {
      mockClient.retrieve.mockResolvedValue([{ id: 1, payload: { text: "test" } }]);

      const point = await manager.getPoint("test-collection", 1);

      expect(point).toEqual({ id: 1, payload: { text: "test" } });
      expect(mockClient.retrieve).toHaveBeenCalledWith("test-collection", {
        ids: [1],
      });
    });

    it("should return null if point not found", async () => {
      mockClient.retrieve.mockResolvedValue([]);

      const point = await manager.getPoint("test-collection", 1);

      expect(point).toBeNull();
    });

    it("should handle errors gracefully", async () => {
      mockClient.retrieve.mockRejectedValue(new Error("Not found"));

      const point = await manager.getPoint("test-collection", 1);

      expect(point).toBeNull();
    });

    it("should handle null payload", async () => {
      mockClient.retrieve.mockResolvedValue([{ id: 1, payload: null }]);

      const point = await manager.getPoint("test-collection", 1);

      expect(point).toEqual({ id: 1, payload: undefined });
    });
  });

  describe("deletePoints", () => {
    it("should delete points by ids", async () => {
      await manager.deletePoints("test-collection", [1, 2, 3]);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: [1, 2, 3],
      });
    });

    it("should delete single point", async () => {
      await manager.deletePoints("test-collection", ["doc-1"]);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: ["bb0e4f49-4437-94d9-01e8-969ff11bd112"], // Normalized UUID from 'doc-1'
      });
    });
  });

  describe("deletePointsByFilter", () => {
    it("should delete points matching filter", async () => {
      const filter = {
        must: [{ key: "relativePath", match: { value: "src/test.ts" } }],
      };
      await manager.deletePointsByFilter("test-collection", filter);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        filter,
      });
    });

    it("should delete points with complex filter", async () => {
      const filter = {
        must: [
          { key: "relativePath", match: { value: "src/utils.ts" } },
          { key: "language", match: { value: "typescript" } },
        ],
      };
      await manager.deletePointsByFilter("test-collection", filter);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        filter,
      });
    });

    it("should handle delete operation failures gracefully", async () => {
      const filter = {
        must: [{ key: "category", match: { value: "test" } }],
      };

      mockClient.delete.mockRejectedValueOnce(new Error("Delete failed"));

      await expect(manager.deletePointsByFilter("test-collection", filter)).rejects.toThrow("Delete failed");

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        filter,
      });
    });
  });

  describe("query (recommend)", () => {
    it("should return results from query API with recommend sub-query", async () => {
      mockClient.getCollection.mockResolvedValue({
        config: { params: { vectors: { size: 3, distance: "Cosine" } } },
        points_count: 10,
      });
      mockClient.query.mockResolvedValue({
        points: [{ id: "abc-123", score: 0.95, payload: { relativePath: "test.ts" } }],
      });

      const results = await manager.query("test-col", {
        positive: ["seed-id"],
        limit: 5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("abc-123");
      expect(results[0].score).toBe(0.95);
      expect(mockClient.query).toHaveBeenCalledWith(
        "test-col",
        expect.objectContaining({
          query: { recommend: { positive: ["seed-id"] } },
          limit: 5,
        }),
      );
    });

    it("should pass filter and offset when provided", async () => {
      mockClient.getCollection.mockResolvedValue({
        config: { params: { vectors: { size: 3, distance: "Cosine" } } },
        points_count: 10,
      });
      mockClient.query.mockResolvedValue({ points: [] });

      await manager.query("test-col", {
        positive: ["seed-id"],
        negative: ["neg-id"],
        strategy: "best_score",
        limit: 10,
        offset: 5,
        filter: { must: [{ key: "language", match: { value: "typescript" } }] },
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        "test-col",
        expect.objectContaining({
          query: { recommend: { positive: ["seed-id"], negative: ["neg-id"], strategy: "best_score" } },
          limit: 10,
          offset: 5,
          filter: { must: [{ key: "language", match: { value: "typescript" } }] },
        }),
      );
    });

    it("should throw QdrantPointNotFoundError when recommend API returns 404", async () => {
      const { QdrantPointNotFoundError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.getCollection.mockResolvedValue({
        config: { params: { vectors: { size: 3, distance: "Cosine" } } },
        points_count: 10,
      });
      const notFoundError = Object.assign(new Error("Not Found"), { status: 404 });
      mockClient.query.mockRejectedValue(notFoundError);

      await expect(manager.query("test-col", { positive: ["non-existent-id"], limit: 5 })).rejects.toThrow(
        QdrantPointNotFoundError,
      );
    });
  });

  describe("hybridSearch", () => {
    const denseVector = [0.1, 0.2, 0.3];
    const sparseVector = { indices: [1, 5, 10], values: [0.5, 0.3, 0.2] };

    function mockParallelSearch(denseHits: any[], sparseHits: any[]) {
      let callCount = 0;
      mockClient.search.mockImplementation(async () => {
        const hits = callCount === 0 ? denseHits : sparseHits;
        callCount++;
        return Promise.resolve(hits);
      });
    }

    it("should run dense and sparse searches in parallel", async () => {
      mockParallelSearch(
        [
          { id: "a", score: 0.9, payload: { text: "result1" } },
          { id: "b", score: 0.7, payload: { text: "result2" } },
        ],
        [
          { id: "a", score: 0.8, payload: { text: "result1" } },
          { id: "c", score: 0.6, payload: { text: "result3" } },
        ],
      );

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20);

      // Two client.search calls (dense + sparse)
      expect(mockClient.search).toHaveBeenCalledTimes(2);
      // Dense call uses named vector
      expect(mockClient.search).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          vector: { name: "dense", vector: denseVector },
        }),
      );
      // Sparse call uses named vector
      expect(mockClient.search).toHaveBeenCalledWith(
        "test-collection",
        expect.objectContaining({
          vector: { name: "text", vector: sparseVector },
        }),
      );
      // Results are merged and sorted
      expect(results.length).toBe(3);
      expect(results[0].id).toBe("a"); // appears in both, highest combined
    });

    it("should apply semanticWeight to score blending (default 0.7)", async () => {
      mockParallelSearch(
        [{ id: "a", score: 1.0, payload: { text: "dense-only" } }],
        [{ id: "b", score: 1.0, payload: { text: "sparse-only" } }],
      );

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20);

      // Dense-only: 0.7 * 1.0 + 0.3 * 0 = 0.7
      // Sparse-only: 0.7 * 0 + 0.3 * 1.0 = 0.3
      const denseResult = results.find((r) => r.id === "a")!;
      const sparseResult = results.find((r) => r.id === "b")!;
      expect(denseResult.score).toBeCloseTo(0.7, 5);
      expect(sparseResult.score).toBeCloseTo(0.3, 5);
    });

    it("should respect custom semanticWeight", async () => {
      mockParallelSearch([{ id: "a", score: 1.0, payload: {} }], [{ id: "b", score: 1.0, payload: {} }]);

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, undefined, 0.5);

      const denseResult = results.find((r) => r.id === "a")!;
      const sparseResult = results.find((r) => r.id === "b")!;
      expect(denseResult.score).toBeCloseTo(0.5, 5);
      expect(sparseResult.score).toBeCloseTo(0.5, 5);
    });

    it("should pass fetchLimit directly to Qdrant (no internal calculation)", async () => {
      mockParallelSearch([], []);

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 40);

      // fetchLimit is passed through as-is — no internal multiplication
      expect(mockClient.search).toHaveBeenCalledWith("test-collection", expect.objectContaining({ limit: 40 }));
    });

    it("should return all fused results without slicing", async () => {
      mockParallelSearch(
        [
          { id: "a", score: 0.9, payload: { text: "dense-1" } },
          { id: "b", score: 0.8, payload: { text: "dense-2" } },
          { id: "c", score: 0.7, payload: { text: "dense-3" } },
        ],
        [
          { id: "b", score: 0.9, payload: { text: "sparse-overlap" } },
          { id: "d", score: 0.8, payload: { text: "sparse-only" } },
        ],
      );

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20);
      expect(results).toHaveLength(4);
      expect(results.map((r) => r.id).sort()).toEqual(["a", "b", "c", "d"]);
    });

    it("should convert simple filter to Qdrant format", async () => {
      mockParallelSearch([], []);
      const filter = { category: "test", type: "doc" };

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, filter);

      const expectedFilter = {
        must: [
          { key: "category", match: { value: "test" } },
          { key: "type", match: { value: "doc" } },
        ],
      };
      // Both calls should have the converted filter
      for (const call of mockClient.search.mock.calls) {
        expect(call[1].filter).toEqual(expectedFilter);
      }
    });

    it("should handle Qdrant format filter (must)", async () => {
      mockParallelSearch([], []);
      const filter = { must: [{ key: "status", match: { value: "active" } }] };

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, filter);

      for (const call of mockClient.search.mock.calls) {
        expect(call[1].filter).toEqual(filter);
      }
    });

    it("should handle Qdrant format filter (should)", async () => {
      mockParallelSearch([], []);
      const filter = { should: [{ key: "tag", match: { value: "important" } }] };

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, filter);

      for (const call of mockClient.search.mock.calls) {
        expect(call[1].filter).toEqual(filter);
      }
    });

    it("should handle Qdrant format filter (must_not)", async () => {
      mockParallelSearch([], []);
      const filter = { must_not: [{ key: "status", match: { value: "deleted" } }] };

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, filter);

      for (const call of mockClient.search.mock.calls) {
        expect(call[1].filter).toEqual(filter);
      }
    });

    it("should handle empty filter object", async () => {
      mockParallelSearch([], []);

      await manager.hybridSearch("test-collection", denseVector, sparseVector, 20, {});

      for (const call of mockClient.search.mock.calls) {
        expect(call[1].filter).toBeUndefined();
      }
    });

    it("should handle null payload in results", async () => {
      mockParallelSearch([{ id: "a", score: 0.9, payload: null }], []);

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20);

      expect(results[0].payload).toBeUndefined();
    });

    it("should min-max normalize scores before blending", async () => {
      mockParallelSearch(
        [
          { id: "a", score: 0.9, payload: {} },
          { id: "b", score: 0.5, payload: {} },
        ],
        [],
      );

      const results = await manager.hybridSearch("test-collection", denseVector, sparseVector, 20);

      // After min-max: a=1.0, b=0.0. With 0.7 weight: a=0.7, b=0.0
      const a = results.find((r) => r.id === "a")!;
      const b = results.find((r) => r.id === "b")!;
      expect(a.score).toBeCloseTo(0.7, 5);
      expect(b.score).toBeCloseTo(0.0, 5);
    });

    it("should throw error with error.data.status.error message", async () => {
      mockClient.search.mockRejectedValue({
        data: { status: { error: "Named vector not found" } },
      });

      await expect(manager.hybridSearch("test-collection", denseVector, sparseVector, 20)).rejects.toThrow(
        QdrantOperationError,
      );
    });

    it("should throw error with error.message fallback", async () => {
      mockClient.search.mockRejectedValue(new Error("Network timeout"));

      await expect(manager.hybridSearch("test-collection", denseVector, sparseVector, 20)).rejects.toThrow(
        QdrantOperationError,
      );
    });

    it("should throw error with String(error) fallback", async () => {
      mockClient.search.mockRejectedValue("Unknown error");

      await expect(manager.hybridSearch("test-collection", denseVector, sparseVector, 20)).rejects.toThrow(
        QdrantOperationError,
      );
    });
  });

  describe("addPointsWithSparse", () => {
    it("should add points with dense and sparse vectors", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1, 5], values: [0.5, 0.3] },
          payload: { text: "test" },
        },
        {
          id: 2,
          vector: [0.4, 0.5, 0.6],
          sparseVector: { indices: [2, 8], values: [0.4, 0.6] },
          payload: { text: "test2" },
        },
      ];

      await manager.addPointsWithSparse("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: [
          {
            id: 1,
            vector: {
              dense: [0.1, 0.2, 0.3],
              text: { indices: [1, 5], values: [0.5, 0.3] },
            },
            payload: { text: "test" },
          },
          {
            id: 2,
            vector: {
              dense: [0.4, 0.5, 0.6],
              text: { indices: [2, 8], values: [0.4, 0.6] },
            },
            payload: { text: "test2" },
          },
        ],
      });
    });

    it("should add points without payload", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      await manager.addPointsWithSparse("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: [
          {
            id: 1,
            vector: {
              dense: [0.1, 0.2, 0.3],
              text: { indices: [1], values: [0.5] },
            },
            payload: undefined,
          },
        ],
      });
    });

    it("should normalize string IDs to UUID format", async () => {
      const points = [
        {
          id: "my-doc-id",
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
          payload: { text: "test" },
        },
      ];

      await manager.addPointsWithSparse("test-collection", points);

      const { calls } = mockClient.upsert.mock;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("test-collection");

      const normalizedId = calls[0][1].points[0].id;
      // Check that it's a valid UUID format
      expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(normalizedId).not.toBe("my-doc-id");
    });

    it("should preserve UUID format IDs without modification", async () => {
      const uuidId = "123e4567-e89b-12d3-a456-426614174000";
      const points = [
        {
          id: uuidId,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
          payload: { text: "test" },
        },
      ];

      await manager.addPointsWithSparse("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: true,
        points: [
          {
            id: uuidId,
            vector: {
              dense: [0.1, 0.2, 0.3],
              text: { indices: [1], values: [0.5] },
            },
            payload: { text: "test" },
          },
        ],
      });
    });

    it("should throw error with error.data.status.error message", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue({
        data: {
          status: {
            error: "Sparse vector not configured",
          },
        },
      });

      await expect(manager.addPointsWithSparse("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw error with error.message fallback", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue(new Error("Connection refused"));

      await expect(manager.addPointsWithSparse("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should throw error with String(error) fallback", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue("Unexpected error");

      await expect(manager.addPointsWithSparse("test-collection", points)).rejects.toThrow(QdrantOperationError);
    });

    it("should handle empty points array gracefully", async () => {
      await manager.addPointsWithSparse("test-collection", []);

      // Should not call upsert for empty arrays
      expect(mockClient.upsert).not.toHaveBeenCalled();
    });
  });

  describe("addPointsWithSparseOptimized", () => {
    it("should add points with optimized settings (wait=false)", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1, 5], values: [0.5, 0.3] },
          payload: { text: "test" },
        },
      ];

      await manager.addPointsWithSparseOptimized("test-collection", points, {
        wait: false,
        ordering: "weak",
      });

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: false,
        ordering: "weak",
        points: [
          {
            id: 1,
            vector: {
              dense: [0.1, 0.2, 0.3],
              text: { indices: [1, 5], values: [0.5, 0.3] },
            },
            payload: { text: "test" },
          },
        ],
      });
    });

    it("should use default options when not provided", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
          payload: { text: "test" },
        },
      ];

      await manager.addPointsWithSparseOptimized("test-collection", points);

      expect(mockClient.upsert).toHaveBeenCalledWith("test-collection", {
        wait: false,
        ordering: "weak",
        points: expect.any(Array),
      });
    });

    it("should handle empty points array gracefully", async () => {
      await manager.addPointsWithSparseOptimized("test-collection", []);

      // Should not call upsert for empty arrays
      expect(mockClient.upsert).not.toHaveBeenCalled();
    });

    it("should normalize string IDs to UUID format", async () => {
      const points = [
        {
          id: "my-optimized-doc",
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
          payload: { text: "test" },
        },
      ];

      await manager.addPointsWithSparseOptimized("test-collection", points);

      const { calls } = mockClient.upsert.mock;
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe("test-collection");

      const normalizedId = calls[0][1].points[0].id;
      // Check that it's a valid UUID format
      expect(normalizedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
      expect(normalizedId).not.toBe("my-optimized-doc");
    });

    it("should throw error with error.data.status.error message", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue({
        data: {
          status: {
            error: "Sparse vector dimension mismatch",
          },
        },
      });

      await expect(manager.addPointsWithSparseOptimized("test-collection", points)).rejects.toThrow(
        QdrantOperationError,
      );
    });

    it("should throw error with error.message fallback", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue(new Error("Network timeout"));

      await expect(manager.addPointsWithSparseOptimized("test-collection", points)).rejects.toThrow(
        QdrantOperationError,
      );
    });

    it("should throw error with String(error) fallback", async () => {
      const points = [
        {
          id: 1,
          vector: [0.1, 0.2, 0.3],
          sparseVector: { indices: [1], values: [0.5] },
        },
      ];

      mockClient.upsert.mockRejectedValue("Unknown error occurred");

      await expect(manager.addPointsWithSparseOptimized("test-collection", points)).rejects.toThrow(
        QdrantOperationError,
      );
    });
  });

  describe("deletePointsByPaths", () => {
    it("should delete points with OR filter for multiple paths", async () => {
      mockClient.delete.mockResolvedValue({});

      const paths = ["src/file1.ts", "src/file2.ts", "src/file3.ts"];
      await manager.deletePointsByPaths("test-collection", paths);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        filter: {
          should: [
            { key: "relativePath", match: { value: "src/file1.ts" } },
            { key: "relativePath", match: { value: "src/file2.ts" } },
            { key: "relativePath", match: { value: "src/file3.ts" } },
          ],
        },
      });
    });

    it("should do nothing for empty paths array", async () => {
      await manager.deletePointsByPaths("test-collection", []);
      expect(mockClient.delete).not.toHaveBeenCalled();
    });

    it("should handle single path", async () => {
      mockClient.delete.mockResolvedValue({});

      await manager.deletePointsByPaths("test-collection", ["single.ts"]);

      expect(mockClient.delete).toHaveBeenCalledWith("test-collection", {
        wait: true,
        filter: {
          should: [{ key: "relativePath", match: { value: "single.ts" } }],
        },
      });
    });
  });

  describe("deletePointsByPathsBatched", () => {
    it("should process paths in batches", async () => {
      mockClient.delete.mockResolvedValue({});

      const paths = Array.from({ length: 25 }, (_, i) => `file${i}.ts`);
      const result = await manager.deletePointsByPathsBatched("test-collection", paths, {
        batchSize: 10,
        concurrency: 2,
      });

      expect(result.deletedPaths).toBe(25);
      expect(result.batchCount).toBe(3); // 10 + 10 + 5
      expect(mockClient.delete).toHaveBeenCalledTimes(3);
    });

    it("should return immediately for empty paths", async () => {
      const result = await manager.deletePointsByPathsBatched("test-collection", [], {
        batchSize: 500,
        concurrency: 8,
      });

      expect(result.deletedPaths).toBe(0);
      expect(result.batchCount).toBe(0);
      expect(result.durationMs).toBe(0);
      expect(mockClient.delete).not.toHaveBeenCalled();
    });

    it("should use wait=false for intermediate batches and wait=true for last batch", async () => {
      mockClient.delete.mockResolvedValue({});

      const paths = Array.from({ length: 20 }, (_, i) => `file${i}.ts`);
      await manager.deletePointsByPathsBatched("test-collection", paths, {
        batchSize: 10,
        concurrency: 4,
      });

      const { calls } = mockClient.delete.mock;
      expect(calls).toHaveLength(2);

      // First batch should have wait=false
      expect(calls[0][1].wait).toBe(false);

      // Last batch should have wait=true
      expect(calls[1][1].wait).toBe(true);
    });

    it("should invoke progress callback", async () => {
      mockClient.delete.mockResolvedValue({});

      const paths = Array.from({ length: 15 }, (_, i) => `file${i}.ts`);
      const progressCalls: [number, number][] = [];

      await manager.deletePointsByPathsBatched("test-collection", paths, {
        batchSize: 5,
        concurrency: 2,
        onProgress: (deleted, total) => {
          progressCalls.push([deleted, total]);
        },
      });

      expect(progressCalls).toHaveLength(3);
      expect(progressCalls[2]).toEqual([15, 15]); // Final progress
    });

    it("should respect concurrency limit", async () => {
      let activeCalls = 0;
      let maxActiveCalls = 0;

      mockClient.delete.mockImplementation(async () => {
        activeCalls++;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await new Promise((r) => setTimeout(r, 10));
        activeCalls--;
        return {};
      });

      const paths = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
      await manager.deletePointsByPathsBatched("test-collection", paths, {
        batchSize: 10,
        concurrency: 2,
      });

      // Should never exceed concurrency + 1 (final batch runs after waiting)
      expect(maxActiveCalls).toBeLessThanOrEqual(3);
    });

    it("should handle errors during batch deletion", async () => {
      mockClient.delete.mockRejectedValue(new Error("Delete failed"));

      const paths = ["file1.ts", "file2.ts"];

      await expect(
        manager.deletePointsByPathsBatched("test-collection", paths, { batchSize: 500, concurrency: 8 }),
      ).rejects.toThrow("Delete failed");
    });

    it("should calculate duration correctly", async () => {
      mockClient.delete.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {};
      });

      const paths = ["file1.ts", "file2.ts"];
      const result = await manager.deletePointsByPathsBatched("test-collection", paths, {
        batchSize: 500,
        concurrency: 8,
      });

      expect(result.durationMs).toBeGreaterThan(0);
    });
  });

  describe("createPayloadIndex", () => {
    it("should create a keyword payload index", async () => {
      await manager.createPayloadIndex("test-collection", "relativePath", "keyword");

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith("test-collection", {
        field_name: "relativePath",
        field_schema: "keyword",
        wait: true,
      });
    });

    it("should create an integer payload index", async () => {
      await manager.createPayloadIndex("test-collection", "startLine", "integer");

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith("test-collection", {
        field_name: "startLine",
        field_schema: "integer",
        wait: true,
      });
    });

    it("should create a text payload index for full-text search", async () => {
      await manager.createPayloadIndex("test-collection", "content", "text");

      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith("test-collection", {
        field_name: "content",
        field_schema: "text",
        wait: true,
      });
    });
  });

  describe("hasPayloadIndex", () => {
    it("should return true if index exists", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        payload_schema: {
          relativePath: { data_type: "keyword", points: 1000 },
        },
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const exists = await manager.hasPayloadIndex("test-collection", "relativePath");

      expect(exists).toBe(true);
    });

    it("should return false if index does not exist", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        payload_schema: {},
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const exists = await manager.hasPayloadIndex("test-collection", "relativePath");

      expect(exists).toBe(false);
    });

    it("should return false if payload_schema is undefined", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const exists = await manager.hasPayloadIndex("test-collection", "relativePath");

      expect(exists).toBe(false);
    });

    it("should return false on error", async () => {
      mockClient.getCollection.mockRejectedValue(new Error("Collection not found"));

      const exists = await manager.hasPayloadIndex("test-collection", "relativePath");

      expect(exists).toBe(false);
    });
  });

  describe("ensurePayloadIndex", () => {
    it("should create index if it does not exist", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        payload_schema: {},
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const created = await manager.ensurePayloadIndex("test-collection", "relativePath", "keyword");

      expect(created).toBe(true);
      expect(mockClient.createPayloadIndex).toHaveBeenCalledWith("test-collection", {
        field_name: "relativePath",
        field_schema: "keyword",
        wait: true,
      });
    });

    it("should not create index if it already exists", async () => {
      mockClient.getCollection.mockResolvedValue({
        collection_name: "test-collection",
        payload_schema: {
          relativePath: { data_type: "keyword", points: 1000 },
        },
        config: { params: { vectors: { size: 768, distance: "Cosine" } } },
      });

      const created = await manager.ensurePayloadIndex("test-collection", "relativePath", "keyword");

      expect(created).toBe(false);
      expect(mockClient.createPayloadIndex).not.toHaveBeenCalled();
    });
  });

  describe("setPayload", () => {
    it("should call client.setPayload with normalized IDs and defaults", async () => {
      await manager.setPayload(
        "test-collection",
        { git: { ageDays: 5 } },
        {
          points: ["point-1", "point-2"],
        },
      );

      expect(mockClient.setPayload).toHaveBeenCalledWith("test-collection", {
        payload: { git: { ageDays: 5 } },
        points: [expect.any(String), expect.any(String)],
        filter: undefined,
        wait: false,
        ordering: "weak",
      });
    });

    it("should pass custom wait and ordering options", async () => {
      await manager.setPayload(
        "test-collection",
        { key: "value" },
        {
          points: ["id-1"],
          wait: true,
          ordering: "strong",
        },
      );

      expect(mockClient.setPayload).toHaveBeenCalledWith("test-collection", {
        payload: { key: "value" },
        points: [expect.any(String)],
        filter: undefined,
        wait: true,
        ordering: "strong",
      });
    });

    it("should support filter-based payload update", async () => {
      const filter = { must: [{ key: "language", match: { value: "typescript" } }] };
      await manager.setPayload("test-collection", { reviewed: true }, { filter });

      expect(mockClient.setPayload).toHaveBeenCalledWith("test-collection", {
        payload: { reviewed: true },
        points: undefined,
        filter,
        wait: false,
        ordering: "weak",
      });
    });
  });

  describe("batchSetPayload", () => {
    it("should early return on empty operations", async () => {
      await manager.batchSetPayload("test-collection", []);

      expect(mockClient.batchUpdate).not.toHaveBeenCalled();
    });

    it("should call batchUpdate with set_payload operations", async () => {
      const operations = [
        { payload: { git: { ageDays: 1 } }, points: ["id-1"] as (string | number)[] },
        { payload: { git: { ageDays: 2 } }, points: ["id-2"] as (string | number)[] },
      ];

      await manager.batchSetPayload("test-collection", operations);

      expect(mockClient.batchUpdate).toHaveBeenCalledWith("test-collection", {
        operations: [
          { set_payload: { payload: { git: { ageDays: 1 } }, points: [expect.any(String)] } },
          { set_payload: { payload: { git: { ageDays: 2 } }, points: [expect.any(String)] } },
        ],
        wait: false,
        ordering: "weak",
      });
    });

    it("should split into sub-batches of 100", async () => {
      const operations = Array.from({ length: 150 }, (_, i) => ({
        payload: { index: i },
        points: [`id-${i}`] as (string | number)[],
      }));

      await manager.batchSetPayload("test-collection", operations);

      // Should have been called twice: batch of 100 + batch of 50
      expect(mockClient.batchUpdate).toHaveBeenCalledTimes(2);

      // First batch: 100 operations, wait=false (not last)
      const firstCall = mockClient.batchUpdate.mock.calls[0];
      expect(firstCall[1].operations).toHaveLength(100);
      expect(firstCall[1].wait).toBe(false);

      // Second batch: 50 operations, wait=false (default)
      const secondCall = mockClient.batchUpdate.mock.calls[1];
      expect(secondCall[1].operations).toHaveLength(50);
    });

    it("should pass custom wait option to last batch", async () => {
      const operations = Array.from({ length: 150 }, (_, i) => ({
        payload: { index: i },
        points: [`id-${i}`] as (string | number)[],
      }));

      await manager.batchSetPayload("test-collection", operations, { wait: true });

      // Last batch should have wait=true
      const lastCall = mockClient.batchUpdate.mock.calls[1];
      expect(lastCall[1].wait).toBe(true);

      // Non-last batch should have wait=false
      const firstCall = mockClient.batchUpdate.mock.calls[0];
      expect(firstCall[1].wait).toBe(false);
    });

    it("should include key in set_payload when op.key is provided", async () => {
      const operations = [{ payload: { git: { ageDays: 1 } }, points: ["id-1"] as (string | number)[], key: "git" }];

      await manager.batchSetPayload("test-collection", operations);

      expect(mockClient.batchUpdate).toHaveBeenCalledWith("test-collection", {
        operations: [
          {
            set_payload: {
              payload: { git: { ageDays: 1 } },
              points: [expect.any(String)],
              key: "git",
            },
          },
        ],
        wait: false,
        ordering: "weak",
      });
    });
  });

  describe("scrollOrdered", () => {
    it("should scroll points ordered by payload field", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [
          { id: "a", payload: { methodLines: 200 } },
          { id: "b", payload: { methodLines: 100 } },
        ],
      });

      const results = await manager.scrollOrdered("test", { key: "methodLines", direction: "desc" }, 10);

      expect(results).toEqual([
        { id: "a", payload: { methodLines: 200 } },
        { id: "b", payload: { methodLines: 100 } },
      ]);
      expect(mockClient.scroll).toHaveBeenCalledWith("test", {
        limit: 10,
        with_payload: true,
        with_vector: false,
        order_by: { key: "methodLines", direction: "desc" },
      });
    });

    it("should pass filter when provided", async () => {
      mockClient.scroll.mockResolvedValueOnce({ points: [] });

      await manager.scrollOrdered("test", { key: "methodLines", direction: "desc" }, 5, {
        must: [{ key: "language", match: { value: "typescript" } }],
      });

      expect(mockClient.scroll).toHaveBeenCalledWith("test", expect.objectContaining({ filter: expect.any(Object) }));
    });

    it("should filter out points with null payload", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [
          { id: "a", payload: { methodLines: 200 } },
          { id: "b", payload: null },
          { id: "c", payload: undefined },
        ],
      });

      const results = await manager.scrollOrdered("test", { key: "methodLines", direction: "desc" }, 10);
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("a");
    });

    it("should throw with descriptive error on failure", async () => {
      mockClient.scroll.mockRejectedValueOnce(new Error("connection refused"));

      await expect(manager.scrollOrdered("test", { key: "methodLines", direction: "desc" }, 10)).rejects.toThrow(
        QdrantOperationError,
      );
    });
  });

  describe("queryGroups", () => {
    it("should group results by payload field and return one hit per group", async () => {
      mockClient.getCollection.mockResolvedValueOnce({
        config: { params: { vectors: { size: 384, distance: "Cosine" } } },
        points_count: 100,
      });
      mockClient.queryGroups.mockResolvedValueOnce({
        groups: [
          {
            id: "src/auth.ts",
            hits: [{ id: "id1", score: 0.9, payload: { relativePath: "src/auth.ts" } }],
          },
          {
            id: "src/db.ts",
            hits: [
              { id: "id2", score: 0.8, payload: { relativePath: "src/db.ts" } },
              { id: "id3", score: 0.7, payload: { relativePath: "src/db.ts" } },
            ],
          },
        ],
      });

      const results = await manager.queryGroups("test", [0.1, 0.2], {
        groupBy: "relativePath",
        groupSize: 1,
        limit: 10,
      });

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ id: "id1", score: 0.9, payload: { relativePath: "src/auth.ts" } });
      expect(results[1]).toEqual({ id: "id2", score: 0.8, payload: { relativePath: "src/db.ts" } });
    });

    it("should pass filter to queryGroups", async () => {
      mockClient.getCollection.mockResolvedValueOnce({
        config: { params: { vectors: { size: 384, distance: "Cosine" } } },
        points_count: 10,
      });
      mockClient.queryGroups.mockResolvedValueOnce({ groups: [] });

      const filter = { must: [{ key: "language", match: { value: "typescript" } }] };
      await manager.queryGroups("test", [0.1], { groupBy: "relativePath", limit: 5, filter });

      expect(mockClient.queryGroups).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ filter, group_by: "relativePath", group_size: 1, limit: 5 }),
      );
    });

    it("should use named vector for hybrid collections", async () => {
      mockClient.getCollection.mockResolvedValueOnce({
        config: {
          params: {
            vectors: {
              dense: { size: 384, distance: "Cosine" },
            },
            sparse_vectors: { bm25: {} },
          },
        },
        points_count: 10,
      });
      mockClient.queryGroups.mockResolvedValueOnce({ groups: [] });

      await manager.queryGroups("hybrid-col", [0.1], { groupBy: "relativePath", limit: 5 });

      expect(mockClient.queryGroups).toHaveBeenCalledWith(
        "hybrid-col",
        expect.objectContaining({ query: [0.1], using: "dense" }),
      );
    });

    it("should handle empty groups", async () => {
      mockClient.getCollection.mockResolvedValueOnce({
        config: { params: { vectors: { size: 384, distance: "Cosine" } } },
        points_count: 0,
      });
      mockClient.queryGroups.mockResolvedValueOnce({ groups: [] });

      const results = await manager.queryGroups("test", [0.1], { groupBy: "relativePath", limit: 10 });
      expect(results).toHaveLength(0);
    });
  });

  describe("scrollFieldValues", () => {
    it("should return unique field values from all pages", async () => {
      mockClient.scroll
        .mockResolvedValueOnce({
          points: [
            { payload: { relativePath: "src/a.ts" } },
            { payload: { relativePath: "src/b.ts" } },
            { payload: { relativePath: "src/a.ts" } }, // duplicate
          ],
          next_page_offset: "page2",
        })
        .mockResolvedValueOnce({
          points: [{ payload: { relativePath: "src/c.ts" } }],
          next_page_offset: null,
        });

      const values = await manager.scrollFieldValues("test-col", "relativePath");
      expect(values).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
      expect(mockClient.scroll).toHaveBeenCalledTimes(2);
      expect(mockClient.scroll).toHaveBeenCalledWith("test-col", {
        limit: 1000,
        offset: undefined,
        with_payload: { include: ["relativePath"] },
        with_vector: false,
      });
    });

    it("should handle empty collection", async () => {
      mockClient.scroll.mockResolvedValueOnce({ points: [], next_page_offset: null });

      const values = await manager.scrollFieldValues("test-col", "relativePath");
      expect(values).toEqual([]);
    });

    it("should skip non-string values", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [{ payload: { relativePath: "src/a.ts" } }, { payload: { relativePath: 123 } }, { payload: {} }],
        next_page_offset: null,
      });

      const values = await manager.scrollFieldValues("test-col", "relativePath");
      expect(values).toEqual(["src/a.ts"]);
    });
  });

  describe("updateCollectionSparseConfig", () => {
    it("calls updateCollection with sparse_vectors idf config", async () => {
      await manager.updateCollectionSparseConfig("my-collection");

      expect(mockClient.updateCollection).toHaveBeenCalledWith("my-collection", {
        sparse_vectors: { text: { modifier: "idf" } },
      });
    });
  });

  describe("scrollWithVectors", () => {
    it("yields a batch with id, payload, and vector", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [
          { id: "abc", payload: { lang: "ts" }, vector: [0.1, 0.2] },
          { id: "def", payload: { lang: "js" }, vector: [0.3, 0.4] },
        ],
        next_page_offset: null,
      });

      const batches: { id: string | number; payload: Record<string, unknown>; vector: unknown }[][] = [];
      for await (const batch of manager.scrollWithVectors("test-col")) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { id: "abc", payload: { lang: "ts" }, vector: [0.1, 0.2] },
        { id: "def", payload: { lang: "js" }, vector: [0.3, 0.4] },
      ]);
      expect(mockClient.scroll).toHaveBeenCalledWith("test-col", {
        limit: 100,
        offset: undefined,
        with_payload: true,
        with_vector: true,
      });
    });

    it("handles pagination across multiple pages", async () => {
      mockClient.scroll
        .mockResolvedValueOnce({
          points: [{ id: 1, payload: { x: "a" }, vector: [0.1] }],
          next_page_offset: "cursor-1",
        })
        .mockResolvedValueOnce({
          points: [{ id: 2, payload: { x: "b" }, vector: [0.2] }],
          next_page_offset: null,
        });

      const batches: { id: string | number; payload: Record<string, unknown>; vector: unknown }[][] = [];
      for await (const batch of manager.scrollWithVectors("test-col", 50)) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(2);
      expect(batches[0][0].id).toBe(1);
      expect(batches[1][0].id).toBe(2);
      expect(mockClient.scroll).toHaveBeenCalledTimes(2);
      expect(mockClient.scroll).toHaveBeenNthCalledWith(1, "test-col", {
        limit: 50,
        offset: undefined,
        with_payload: true,
        with_vector: true,
      });
      expect(mockClient.scroll).toHaveBeenNthCalledWith(2, "test-col", {
        limit: 50,
        offset: "cursor-1",
        with_payload: true,
        with_vector: true,
      });
    });

    it("handles named vectors ({ dense: [...] })", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [{ id: "x", payload: { a: 1 }, vector: { dense: [0.5, 0.6] } }],
        next_page_offset: null,
      });

      const batches: { id: string | number; payload: Record<string, unknown>; vector: unknown }[][] = [];
      for await (const batch of manager.scrollWithVectors("test-col")) {
        batches.push(batch);
      }

      expect(batches[0][0].vector).toEqual({ dense: [0.5, 0.6] });
    });

    it("skips points missing payload or vector", async () => {
      mockClient.scroll.mockResolvedValueOnce({
        points: [
          { id: 1, payload: null, vector: [0.1] },
          { id: 2, payload: { a: 1 }, vector: null },
          { id: 3, payload: { b: 2 }, vector: [0.3] },
        ],
        next_page_offset: null,
      });

      const batches: { id: string | number; payload: Record<string, unknown>; vector: unknown }[][] = [];
      for await (const batch of manager.scrollWithVectors("test-col")) {
        batches.push(batch);
      }

      expect(batches).toHaveLength(1);
      expect(batches[0]).toHaveLength(1);
      expect(batches[0][0].id).toBe(3);
    });
  });

  describe("connection error propagation via call() guard", () => {
    const connectionErrors = [
      "fetch failed",
      "connect ECONNREFUSED 127.0.0.1:6333",
      "getaddrinfo ENOTFOUND qdrant",
      "socket hang up",
      "network error",
      "connect ECONNRESET",
      "connect ETIMEDOUT",
    ];

    for (const msg of connectionErrors) {
      it(`converts "${msg}" to QdrantUnavailableError across methods`, async () => {
        const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
        const error = new Error(msg);

        // listCollections
        mockClient.getCollections.mockRejectedValueOnce(error);
        await expect(manager.listCollections()).rejects.toThrow(QdrantUnavailableError);

        // deleteCollection
        mockClient.deleteCollection.mockRejectedValueOnce(error);
        await expect(manager.deleteCollection("col")).rejects.toThrow(QdrantUnavailableError);
      });
    }

    it("does NOT treat non-Error non-object thrown values as connection errors", async () => {
      mockClient.getCollections.mockRejectedValueOnce("string error");

      await expect(manager.listCollections()).rejects.toBe("string error");
    });

    it("does NOT convert HTTP business errors (status > 0) to QdrantUnavailableError", async () => {
      const httpError = Object.assign(new Error("Bad Request"), { status: 400 });
      mockClient.getCollections.mockRejectedValueOnce(httpError);

      // Should throw the original error, not QdrantUnavailableError
      await expect(manager.listCollections()).rejects.toThrow("Bad Request");
    });

    it("propagates connection errors through search", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.getCollection.mockResolvedValueOnce({
        config: { params: { vectors: { size: 3, distance: "Cosine" } } },
        points_count: 0,
      });
      mockClient.search.mockRejectedValueOnce(new Error("fetch failed"));

      await expect(manager.search("col", [0.1, 0.2, 0.3])).rejects.toThrow(QdrantUnavailableError);
    });

    it("propagates connection errors through scroll operations", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.scroll.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(manager.scrollFieldValues("col", "field")).rejects.toThrow(QdrantUnavailableError);
    });

    it("propagates connection errors through setPayload", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.setPayload.mockRejectedValueOnce(new Error("fetch failed"));

      await expect(manager.setPayload("col", { key: "value" }, { points: ["id1"], wait: true })).rejects.toThrow(
        QdrantUnavailableError,
      );
    });

    it("propagates connection errors through updateCollection", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.updateCollection.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(manager.disableIndexing("col")).rejects.toThrow(QdrantUnavailableError);
    });

    it("propagates connection errors through deletePoints", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.delete.mockRejectedValueOnce(new Error("socket hang up"));

      await expect(manager.deletePoints("col", ["id1"])).rejects.toThrow(QdrantUnavailableError);
    });

    it("propagates connection errors through batchUpdate", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      mockClient.batchUpdate.mockRejectedValueOnce(new Error("ETIMEDOUT"));

      await expect(manager.batchSetPayload("col", [{ payload: { k: "v" }, points: ["id1"] }])).rejects.toThrow(
        QdrantUnavailableError,
      );
    });
  });

  describe("countPoints", () => {
    it("returns count with filter", async () => {
      mockClient.count.mockResolvedValueOnce({ count: 5 });

      const result = await manager.countPoints("col", {
        should: [{ key: "relativePath", match: { value: "src/foo.ts" } }],
      });

      expect(result).toBe(5);
      expect(mockClient.count).toHaveBeenCalledWith("col", {
        filter: { should: [{ key: "relativePath", match: { value: "src/foo.ts" } }] },
        exact: true,
      });
    });

    it("returns count without filter", async () => {
      mockClient.count.mockResolvedValueOnce({ count: 42 });

      const result = await manager.countPoints("col");

      expect(result).toBe(42);
      expect(mockClient.count).toHaveBeenCalledWith("col", { filter: undefined, exact: true });
    });
  });

  describe("reconnect on connection error", () => {
    it("retries with new URL when reconnect returns a new URL", async () => {
      const reconnect = vi.fn().mockReturnValue("http://127.0.0.1:99999");
      const mgr = new QdrantManager("http://127.0.0.1:11111", undefined, reconnect);

      // First call fails, second succeeds (after reconnect recreates client)
      mockClient.getCollections
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        .mockResolvedValueOnce({ collections: [{ name: "test" }] });

      const result = await mgr.listCollections();

      expect(reconnect).toHaveBeenCalledOnce();
      expect(mgr.url).toBe("http://127.0.0.1:99999");
      expect(result).toEqual(["test"]);
    });

    it("throws QdrantUnavailableError when reconnect returns null", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");
      const reconnect = vi.fn().mockReturnValue(null);
      const mgr = new QdrantManager("http://127.0.0.1:11111", undefined, reconnect);

      mockClient.getCollections.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(mgr.listCollections()).rejects.toThrow(QdrantUnavailableError);
      expect(reconnect).toHaveBeenCalledOnce();
    });

    it("throws QdrantUnavailableError without reconnect callback", async () => {
      const { QdrantUnavailableError } = await import("../../../../src/core/adapters/qdrant/errors.js");

      mockClient.getCollections.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(manager.listCollections()).rejects.toThrow(QdrantUnavailableError);
    });
  });

  describe("checkHealth", () => {
    it("should return true when Qdrant is reachable", async () => {
      mockClient.getCollections.mockResolvedValueOnce({ collections: [] });

      const result = await manager.checkHealth();

      expect(result).toBe(true);
      expect(mockClient.getCollections).toHaveBeenCalled();
    });

    it("should return false when Qdrant is unreachable", async () => {
      mockClient.getCollections.mockRejectedValueOnce(new TypeError("fetch failed"));

      const result = await manager.checkHealth();

      expect(result).toBe(false);
    });
  });
});
