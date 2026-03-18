import { beforeEach, describe, expect, it, vi } from "vitest";

import { CURRENT_SCHEMA_VERSION, SchemaManager } from "../../../../src/core/adapters/qdrant/schema-migration.js";

// Mock QdrantManager
const mockQdrant = {
  getPoint: vi.fn(),
  hasPayloadIndex: vi.fn(),
  createPayloadIndex: vi.fn(),
  ensurePayloadIndex: vi.fn(),
  getCollectionInfo: vi.fn(),
  addPoints: vi.fn(),
  addPointsWithSparse: vi.fn(),
};

describe("SchemaManager", () => {
  let schemaManager: SchemaManager;

  beforeEach(() => {
    vi.clearAllMocks();
    schemaManager = new SchemaManager(mockQdrant as any);

    // Default mock implementations
    mockQdrant.getCollectionInfo.mockResolvedValue({
      vectorSize: 768,
      hybridEnabled: false,
    });
    mockQdrant.addPoints.mockResolvedValue(undefined);
  });

  describe("getSchemaVersion", () => {
    it("should return schema version from metadata point", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        id: "__schema_metadata__",
        payload: {
          _type: "schema_metadata",
          schemaVersion: 4,
          migratedAt: "2024-01-01T00:00:00Z",
          indexes: ["relativePath"],
        },
      });

      const version = await schemaManager.getSchemaVersion("test-collection");

      expect(version).toBe(4);
    });

    it("should return 0 for collections without metadata (pre-v4)", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);

      const version = await schemaManager.getSchemaVersion("test-collection");

      expect(version).toBe(0);
    });

    it("should return current version if relativePath index exists but no metadata", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(true);

      const version = await schemaManager.getSchemaVersion("test-collection");

      expect(version).toBe(CURRENT_SCHEMA_VERSION);
    });

    it("should return 0 on error", async () => {
      mockQdrant.getPoint.mockRejectedValue(new Error("Connection failed"));

      const version = await schemaManager.getSchemaVersion("test-collection");

      expect(version).toBe(0);
    });
  });

  describe("ensureCurrentSchema", () => {
    it("should skip migration if already at current version", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: {
          _type: "schema_metadata",
          schemaVersion: CURRENT_SCHEMA_VERSION,
        },
      });

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.migrationsApplied).toHaveLength(0);
      expect(mockQdrant.ensurePayloadIndex).not.toHaveBeenCalled();
    });

    it("should migrate from v0 to v4 by creating relativePath index", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true); // Index was created

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(0);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(result.migrationsApplied).toContain("v4: Created keyword index on relativePath");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "relativePath", "keyword");
    });

    it("should report when index already exists during migration", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(false); // Index already existed

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.migrationsApplied).toContain("v4: relativePath index already exists");
    });

    it("should store schema metadata after migration", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      await schemaManager.ensureCurrentSchema("test-collection");

      expect(mockQdrant.addPoints).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            id: "__schema_metadata__",
            payload: expect.objectContaining({
              _type: "schema_metadata",
              schemaVersion: CURRENT_SCHEMA_VERSION,
              indexes: ["relativePath"],
            }),
          }),
        ]),
      );
    });

    it("should use sparse vectors for hybrid collections", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);
      mockQdrant.getCollectionInfo.mockResolvedValue({
        vectorSize: 768,
        hybridEnabled: true,
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      await schemaManager.ensureCurrentSchema("test-collection");

      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalled();
      expect(mockQdrant.addPoints).not.toHaveBeenCalled();
    });

    it("should handle migration errors gracefully", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockRejectedValue(new Error("Index creation failed"));

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(false);
      expect(result.error).toBe("Index creation failed");
    });
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
              schemaVersion: CURRENT_SCHEMA_VERSION,
              indexes: expect.arrayContaining(["relativePath", "language", "fileExtension", "chunkType"]),
            }),
          }),
        ]),
      );
    });
  });

  describe("v6 migration: static payload indexes", () => {
    it("should create keyword indexes on language, fileExtension, chunkType when migrating from v5", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: {
          _type: "schema_metadata",
          schemaVersion: 5,
          indexes: ["relativePath"],
        },
      });
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(5);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "language", "keyword");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "fileExtension", "keyword");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "chunkType", "keyword");
    });

    it("should apply v6 indexes alongside v4+v5 when migrating from v0", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(0);
      // v4 + v5
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "relativePath", "keyword");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "relativePath", "text");
      // v6
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "language", "keyword");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "fileExtension", "keyword");
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "chunkType", "keyword");
    });

    it("should report v6 migration messages", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: {
          _type: "schema_metadata",
          schemaVersion: 5,
          indexes: ["relativePath"],
        },
      });
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.migrationsApplied).toContain("v6: Created keyword index on language");
      expect(result.migrationsApplied).toContain("v6: Created keyword index on fileExtension");
      expect(result.migrationsApplied).toContain("v6: Created keyword index on chunkType");
    });

    it("should report when v6 indexes already exist", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: {
          _type: "schema_metadata",
          schemaVersion: 5,
          indexes: ["relativePath"],
        },
      });
      mockQdrant.ensurePayloadIndex.mockResolvedValue(false); // already existed

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.migrationsApplied).toContain("v6: language keyword index already exists");
      expect(result.migrationsApplied).toContain("v6: fileExtension keyword index already exists");
      expect(result.migrationsApplied).toContain("v6: chunkType keyword index already exists");
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
  });

  describe("CURRENT_SCHEMA_VERSION", () => {
    it("should be 6", () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(6);
    });
  });
});
