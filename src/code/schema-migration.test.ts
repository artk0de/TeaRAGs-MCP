import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_SCHEMA_VERSION, SchemaManager } from "./schema-migration.js";

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
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith(
        "test-collection",
        "relativePath",
        "keyword",
      );
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

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith(
        "new-collection",
        "relativePath",
        "keyword",
      );
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
              indexes: ["relativePath"],
            }),
          }),
        ]),
      );
    });
  });

  describe("CURRENT_SCHEMA_VERSION", () => {
    it("should be 4", () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(4);
    });
  });
});
