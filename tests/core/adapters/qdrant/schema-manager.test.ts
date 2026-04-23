import { beforeEach, describe, expect, it, vi } from "vitest";

import { SchemaManager } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import { SchemaMigrator } from "../../../../src/core/infra/migration/schema-migrator.js";
import { SparseMigrator } from "../../../../src/core/infra/migration/sparse-migrator.js";

const LATEST_SCHEMA_VERSION = new SchemaMigrator(
  "",
  {
    getSchemaVersion: async () => Promise.resolve(0),
    ensureIndex: async () => Promise.resolve(true),
    storeSchemaVersion: async () => Promise.resolve(),
    hasPayloadIndex: async () => Promise.resolve(false),
    getCollectionInfo: async () => Promise.resolve({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: async () => Promise.resolve(),
  },
  { enableHybrid: false },
).latestVersion;

// Mock QdrantManager
const mockQdrant = {
  getCollectionInfo: vi.fn(),
  createPayloadIndex: vi.fn(),
  addPoints: vi.fn(),
  addPointsWithSparse: vi.fn(),
};

describe("SchemaManager", () => {
  let schemaManager: SchemaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    schemaManager = new SchemaManager(mockQdrant as any, LATEST_SCHEMA_VERSION);

    // Default mock implementations
    mockQdrant.getCollectionInfo.mockResolvedValue({
      vectorSize: 768,
      hybridEnabled: false,
    });
    mockQdrant.addPoints.mockResolvedValue(undefined);
  });

  describe("initializeSchema", () => {
    it("should create relativePath index for new collection", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "relativePath", "keyword");
    });

    it("should store schema metadata after initialization", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "new-collection",
        expect.arrayContaining([
          expect.objectContaining({
            id: "__schema_metadata__",
            payload: expect.objectContaining({
              _type: "schema_metadata",
              schemaVersion: LATEST_SCHEMA_VERSION,
              indexes: expect.arrayContaining(["relativePath", "language", "fileExtension", "chunkType"]),
            }),
          }),
        ]),
      );
    });
  });

  describe("initializeSchema: v6 indexes + text index fix", () => {
    it("should create text index on relativePath for new collections", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "relativePath", "text");
    });

    it("should create keyword indexes on language, fileExtension, chunkType for new collections", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "language", "keyword");
      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "fileExtension", "keyword");
      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "chunkType", "keyword");
    });

    it("should store all index names in schema metadata", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "new-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              indexes: expect.arrayContaining(["relativePath", "language", "fileExtension", "chunkType"]),
            }),
          }),
        ]),
      );
    });

    it("should create text index on symbolId for new collections", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "symbolId", "text");
    });

    it("should use sparse vector store for hybrid collections", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("hybrid-collection");

      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalled();
      expect(mockQdrant.addPoints).not.toHaveBeenCalled();
    });
  });

  describe("sparseVersion in metadata", () => {
    it("should store sparseVersion when provided", async () => {
      const sparseLatest = new SparseMigrator(
        "",
        { getSparseVersion: async () => 0, rebuildSparseVectors: async () => {}, storeSparseVersion: async () => {} },
        true,
      ).latestVersion;
      const manager = new SchemaManager(mockQdrant as any, LATEST_SCHEMA_VERSION, sparseLatest);
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await manager.initializeSchema("test-collection");

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              sparseVersion: sparseLatest,
            }),
          }),
        ]),
      );
    });

    it("should default sparseVersion to 0 when not provided", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("test-collection");

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              sparseVersion: 0,
            }),
          }),
        ]),
      );
    });
  });

  describe("LATEST_SCHEMA_VERSION", () => {
    it("should be 12 with v12 enrichment payload indexes migration", () => {
      expect(LATEST_SCHEMA_VERSION).toBe(12);
    });
  });
});
