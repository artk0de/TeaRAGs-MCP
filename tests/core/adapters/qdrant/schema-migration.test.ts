import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CURRENT_SCHEMA_VERSION,
  CURRENT_SPARSE_VERSION,
  SchemaManager,
} from "../../../../src/core/adapters/qdrant/schema-migration.js";

// Mock sparse vector generation
vi.mock("../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn().mockReturnValue({ indices: [1, 2, 3], values: [0.5, 0.3, 0.2] }),
}));

// Mock QdrantManager
const mockQdrant = {
  getPoint: vi.fn(),
  hasPayloadIndex: vi.fn(),
  createPayloadIndex: vi.fn(),
  ensurePayloadIndex: vi.fn(),
  getCollectionInfo: vi.fn(),
  addPoints: vi.fn(),
  addPointsWithSparse: vi.fn(),
  updateCollectionSparseConfig: vi.fn(),
  scrollWithVectors: vi.fn(),
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

    it("should return 6 (not CURRENT_SCHEMA_VERSION) if relativePath index exists but no metadata", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(true);

      const version = await schemaManager.getSchemaVersion("test-collection");

      // Hardcoded to 6 so v7 migration always runs for manually-migrated collections
      expect(version).toBe(6);
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

    it("should create text index on symbolId for new collections", async () => {
      mockQdrant.createPayloadIndex.mockResolvedValue(undefined);

      await schemaManager.initializeSchema("new-collection");

      expect(mockQdrant.createPayloadIndex).toHaveBeenCalledWith("new-collection", "symbolId", "text");
    });
  });

  describe("CURRENT_SCHEMA_VERSION", () => {
    it("should be 8", () => {
      expect(CURRENT_SCHEMA_VERSION).toBe(8);
    });
  });

  describe("v8 migration: symbolId text index", () => {
    it("should create text index on symbolId when migrating from v7", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: ["relativePath"] },
      });
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(7);
      expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "symbolId", "text");
      expect(result.migrationsApplied).toContain("v8: Created text index on symbolId");
    });

    it("should report when symbolId text index already exists", async () => {
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: ["relativePath"] },
      });
      mockQdrant.ensurePayloadIndex.mockResolvedValue(false);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.migrationsApplied).toContain("v8: symbolId text index already exists");
    });

    it("should apply v8 alongside earlier migrations when migrating from v0", async () => {
      mockQdrant.getPoint.mockResolvedValue(null);
      mockQdrant.hasPayloadIndex.mockResolvedValue(false);
      mockQdrant.ensurePayloadIndex.mockResolvedValue(true);

      const result = await schemaManager.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(result.fromVersion).toBe(0);
      expect(mockQdrant.ensurePayloadIndex).toHaveBeenCalledWith("test-collection", "symbolId", "text");
    });
  });

  describe("v7 migration: sparse vectors", () => {
    it("should enable sparse config when non-hybrid + enableHybrid=true", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 6, indexes: ["relativePath"] },
      });
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 768, hybridEnabled: false });
      mockQdrant.updateCollectionSparseConfig.mockResolvedValue(undefined);

      const result = await sm.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(mockQdrant.updateCollectionSparseConfig).toHaveBeenCalledWith("test-collection");
      expect(result.migrationsApplied).toContain("v7: Enabled sparse vectors on collection");
    });

    it("should skip sparse config when enableHybrid=false", async () => {
      const sm = new SchemaManager(mockQdrant as any, false);
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 6, indexes: ["relativePath"] },
      });
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 768, hybridEnabled: false });

      const result = await sm.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(mockQdrant.updateCollectionSparseConfig).not.toHaveBeenCalled();
      expect(result.migrationsApplied).toContain("v7: Sparse config already present or not requested");
    });

    it("should skip sparse config when already hybrid", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 6, indexes: ["relativePath"] },
      });
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 768, hybridEnabled: true });

      const result = await sm.ensureCurrentSchema("test-collection");

      expect(result.success).toBe(true);
      expect(mockQdrant.updateCollectionSparseConfig).not.toHaveBeenCalled();
      expect(result.migrationsApplied).toContain("v7: Sparse config already present or not requested");
    });

    it("should call updateCollectionSparseConfig before storeSchemaMetadata", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 6, indexes: ["relativePath"] },
      });
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 768, hybridEnabled: false });
      mockQdrant.updateCollectionSparseConfig.mockResolvedValue(undefined);

      const callOrder: string[] = [];
      mockQdrant.updateCollectionSparseConfig.mockImplementation(async () => {
        callOrder.push("updateCollectionSparseConfig");
      });
      // After v7 migration, getCollectionInfo is called again for storeSchemaMetadata
      // We need to track addPoints/addPointsWithSparse
      mockQdrant.addPoints.mockImplementation(async () => {
        callOrder.push("addPoints");
      });
      mockQdrant.addPointsWithSparse.mockImplementation(async () => {
        callOrder.push("addPointsWithSparse");
      });

      await sm.ensureCurrentSchema("test-collection");

      const sparseIdx = callOrder.indexOf("updateCollectionSparseConfig");
      const storeIdx = Math.max(callOrder.indexOf("addPoints"), callOrder.indexOf("addPointsWithSparse"));
      expect(sparseIdx).toBeLessThan(storeIdx);
    });
  });

  describe("checkSparseVectorVersion", () => {
    it("should rebuild when sparseVersion=0 and enableHybrid=true", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [], sparseVersion: 0 },
      });
      // scrollWithVectors returns empty — no points to rebuild
      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          /* empty */
        })(),
      );
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      const result = await sm.checkSparseVectorVersion("test-collection");

      expect(result.rebuilt).toBe(true);
      expect(result.message).toContain("v0");
      expect(result.message).toContain(`v${CURRENT_SPARSE_VERSION}`);
    });

    it("should skip when enableHybrid=false", async () => {
      const sm = new SchemaManager(mockQdrant as any, false);

      const result = await sm.checkSparseVectorVersion("test-collection");

      expect(result.rebuilt).toBe(false);
      expect(mockQdrant.getCollectionInfo).not.toHaveBeenCalled();
    });

    it("should skip when sparseVersion is current", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: {
          _type: "schema_metadata",
          schemaVersion: 7,
          indexes: [],
          sparseVersion: CURRENT_SPARSE_VERSION,
        },
      });

      const result = await sm.checkSparseVectorVersion("test-collection");

      expect(result.rebuilt).toBe(false);
      expect(mockQdrant.scrollWithVectors).not.toHaveBeenCalled();
    });

    it("should add sparse config first when collection is non-hybrid", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: false });
      mockQdrant.updateCollectionSparseConfig.mockResolvedValue(undefined);
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [], sparseVersion: 0 },
      });
      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          /* empty */
        })(),
      );
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      await sm.checkSparseVectorVersion("test-collection");

      expect(mockQdrant.updateCollectionSparseConfig).toHaveBeenCalledWith("test-collection");
    });
  });

  describe("rebuildSparseVectors", () => {
    it("should scroll points, generate sparse vectors, and upsert with dense unchanged", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [] },
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      const testPoints = [
        {
          id: "point-1",
          payload: { content: "function hello() {}", relativePath: "src/hello.ts" },
          vector: { dense: [0.1, 0.2, 0.3] },
        },
        {
          id: "point-2",
          payload: { content: "class World {}", relativePath: "src/world.ts" },
          vector: { dense: [0.4, 0.5, 0.6] },
        },
      ];

      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          yield testPoints;
        })(),
      );

      const result = await sm.checkSparseVectorVersion("test-collection");

      expect(result.rebuilt).toBe(true);
      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalledWith(
        "test-collection",
        expect.arrayContaining([
          expect.objectContaining({
            id: "point-1",
            vector: [0.1, 0.2, 0.3],
            sparseVector: { indices: [1, 2, 3], values: [0.5, 0.3, 0.2] },
          }),
          expect.objectContaining({
            id: "point-2",
            vector: [0.4, 0.5, 0.6],
            sparseVector: { indices: [1, 2, 3], values: [0.5, 0.3, 0.2] },
          }),
        ]),
      );
    });

    it("should skip metadata points during rebuild", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [] },
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      const testPoints = [
        {
          id: "__schema_metadata__",
          payload: { _type: "schema_metadata", schemaVersion: 7 },
          vector: { dense: [0, 0, 0] },
        },
        {
          id: "__indexing_metadata__",
          payload: { _type: "indexing_metadata", embeddingModel: "test" },
          vector: { dense: [0, 0, 0] },
        },
        {
          id: "real-point",
          payload: { content: "real code", relativePath: "src/real.ts" },
          vector: { dense: [0.1, 0.2, 0.3] },
        },
      ];

      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          yield testPoints;
        })(),
      );

      await sm.checkSparseVectorVersion("test-collection");

      // addPointsWithSparse called twice: once for rebuild batch (1 point), once for metadata update
      const rebuildCall = mockQdrant.addPointsWithSparse.mock.calls.find(
        (call: unknown[]) => Array.isArray(call[1]) && call[1].some((p: { id: string }) => p.id === "real-point"),
      );
      expect(rebuildCall).toBeDefined();
      expect(rebuildCall![1]).toHaveLength(1);
      expect(rebuildCall![1][0].id).toBe("real-point");
    });

    it("should handle empty collection gracefully", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [] },
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          /* empty */
        })(),
      );

      const result = await sm.checkSparseVectorVersion("test-collection");

      expect(result.rebuilt).toBe(true);
      // scrollWithVectors yielded nothing, so addPointsWithSparse only called for metadata update
    });

    it("should extract dense vector from unnamed format [1,2,3]", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [] },
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      const testPoints = [
        {
          id: "unnamed-vec",
          payload: { content: "unnamed vector point", relativePath: "src/test.ts" },
          vector: [1, 2, 3], // unnamed format
        },
      ];

      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          yield testPoints;
        })(),
      );

      await sm.checkSparseVectorVersion("test-collection");

      const rebuildCall = mockQdrant.addPointsWithSparse.mock.calls.find(
        (call: unknown[]) => Array.isArray(call[1]) && call[1].some((p: { id: string }) => p.id === "unnamed-vec"),
      );
      expect(rebuildCall).toBeDefined();
      expect(rebuildCall![1][0].vector).toEqual([1, 2, 3]);
    });

    it("should skip points with unrecognized vector format", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "schema_metadata", schemaVersion: 7, indexes: [] },
      });
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

      const testPoints = [
        {
          id: "bad-vec",
          payload: { content: "bad vector", relativePath: "src/test.ts" },
          vector: "not-a-vector", // neither array nor {dense: [...]}
        },
      ];

      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          yield testPoints;
        })(),
      );

      await sm.checkSparseVectorVersion("test-collection");

      // bad-vec should be skipped — only metadata update call
      const rebuildCall = mockQdrant.addPointsWithSparse.mock.calls.find(
        (call: unknown[]) => Array.isArray(call[1]) && call[1].some((p: { id: string }) => p.id === "bad-vec"),
      );
      expect(rebuildCall).toBeUndefined();
    });
  });

  describe("getSchemaMetadata (via checkSparseVectorVersion)", () => {
    it("should return null when point exists but _type is not schema_metadata", async () => {
      // getSchemaMetadata returns null → checkSparseVectorVersion skips rebuild
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      // Return a point with wrong _type — simulates non-schema-metadata point
      mockQdrant.getPoint.mockResolvedValue({
        payload: { _type: "something_else", schemaVersion: 7 },
      });

      const result = await sm.checkSparseVectorVersion("test-collection");

      // sparseVersion is undefined (null metadata) → treated as 0 → needs rebuild
      expect(result.rebuilt).toBe(true);
    });

    it("should return null when getPoint throws", async () => {
      const sm = new SchemaManager(mockQdrant as any, true);
      mockQdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 384, hybridEnabled: true });
      mockQdrant.getPoint.mockRejectedValue(new Error("qdrant unavailable"));
      mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);
      mockQdrant.scrollWithVectors.mockReturnValue(
        (async function* () {
          /* empty */
        })(),
      );

      // getSchemaMetadata catches the error and returns null
      // checkSparseVectorVersion proceeds with sparseVersion=undefined → rebuild
      const result = await sm.checkSparseVectorVersion("test-collection");
      expect(result.rebuilt).toBe(true);
    });
  });
});
