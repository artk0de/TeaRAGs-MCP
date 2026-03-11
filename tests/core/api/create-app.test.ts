import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { createApp, type AppDeps } from "../../../src/core/api/create-app.js";
import type { ExploreFacade } from "../../../src/core/api/explore-facade.js";
import type { IngestFacade } from "../../../src/core/api/ingest-facade.js";
import type { SchemaDriftMonitor } from "../../../src/core/api/schema-drift-monitor.js";
import type { Reranker } from "../../../src/core/explore/reranker.js";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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
    deletePoints: vi.fn().mockResolvedValue(undefined),
    addPoints: vi.fn().mockResolvedValue(undefined),
    addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
  } as unknown as QdrantManager;
}

function createMockEmbeddings(dimensions = 384): EmbeddingProvider {
  return {
    getDimensions: vi.fn().mockReturnValue(dimensions),
    getModel: vi.fn().mockReturnValue("test-model"),
    embed: vi.fn().mockResolvedValue({ embedding: new Array(dimensions).fill(0) }),
    embedBatch: vi.fn().mockResolvedValue([{ embedding: new Array(dimensions).fill(0) }]),
  } as unknown as EmbeddingProvider;
}

function createMockExploreFacade(): ExploreFacade {
  return {
    semanticSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null }),
    hybridSearch: vi.fn().mockResolvedValue({ results: [], driftWarning: null }),
    rankChunks: vi.fn().mockResolvedValue({ results: [], driftWarning: null }),
    searchCodeTyped: vi.fn().mockResolvedValue({ results: [], driftWarning: null }),
    searchCode: vi.fn().mockResolvedValue([]),
  } as unknown as ExploreFacade;
}

function createMockIngestFacade(): IngestFacade {
  return {
    indexCodebase: vi.fn().mockResolvedValue({ totalFiles: 10, totalChunks: 50 }),
    reindexChanges: vi.fn().mockResolvedValue({ added: 1, updated: 2, deleted: 0 }),
    getIndexStatus: vi.fn().mockResolvedValue({ indexed: true, collectionName: "test" }),
    clearIndex: vi.fn().mockResolvedValue(undefined),
  } as unknown as IngestFacade;
}

function createMockReranker(): Reranker {
  return {
    getDescriptorInfo: vi.fn().mockReturnValue([
      { name: "recency", description: "How recently the code was modified" },
      { name: "stability", description: "How stable the code is" },
    ]),
    getPresetNames: vi.fn().mockImplementation((tool: string) => {
      if (tool === "rank_chunks") return ["relevance", "techDebt"];
      return ["relevance", "recent", "stable"];
    }),
  } as unknown as Reranker;
}

function createMockDriftMonitor(): SchemaDriftMonitor {
  return {
    checkAndConsume: vi.fn().mockResolvedValue(null),
    checkByCollectionName: vi.fn().mockReturnValue(null),
  } as unknown as SchemaDriftMonitor;
}

function createMockDeps(): AppDeps {
  return {
    qdrant: createMockQdrant(),
    embeddings: createMockEmbeddings(),
    search: createMockExploreFacade(),
    ingest: createMockIngestFacade(),
    reranker: createMockReranker(),
    schemaDriftMonitor: createMockDriftMonitor(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createApp", () => {
  let deps: AppDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it("should return an object implementing all App methods", () => {
    const app = createApp(deps);

    // Search
    expect(app.semanticSearch).toBeDefined();
    expect(app.hybridSearch).toBeDefined();
    expect(app.rankChunks).toBeDefined();
    expect(app.searchCode).toBeDefined();

    // Indexing
    expect(app.indexCodebase).toBeDefined();
    expect(app.reindexChanges).toBeDefined();
    expect(app.getIndexStatus).toBeDefined();
    expect(app.clearIndex).toBeDefined();

    // Collections
    expect(app.createCollection).toBeDefined();
    expect(app.listCollections).toBeDefined();
    expect(app.getCollectionInfo).toBeDefined();
    expect(app.deleteCollection).toBeDefined();

    // Documents
    expect(app.addDocuments).toBeDefined();
    expect(app.deleteDocuments).toBeDefined();

    // Schema
    expect(app.getSchemaDescriptors).toBeDefined();

    // Drift
    expect(app.checkSchemaDrift).toBeDefined();
  });

  // =========================================================================
  // Search delegation
  // =========================================================================

  describe("search delegation", () => {
    it("delegates semanticSearch to ExploreFacade", async () => {
      const app = createApp(deps);
      const req = { query: "test", path: "/foo" };
      await app.semanticSearch(req);

      expect(deps.search.semanticSearch).toHaveBeenCalledWith(req);
    });

    it("delegates hybridSearch to ExploreFacade", async () => {
      const app = createApp(deps);
      const req = { query: "test", collection: "col1" };
      await app.hybridSearch(req);

      expect(deps.search.hybridSearch).toHaveBeenCalledWith(req);
    });

    it("delegates rankChunks to ExploreFacade", async () => {
      const app = createApp(deps);
      const req = { rerank: "techDebt", level: "chunk" as const, collection: "col1" };
      await app.rankChunks(req);

      expect(deps.search.rankChunks).toHaveBeenCalledWith(req);
    });

    it("delegates searchCode to ExploreFacade.searchCodeTyped", async () => {
      const app = createApp(deps);
      const req = { path: "/foo", query: "test" };
      await app.searchCode(req);

      expect(deps.search.searchCodeTyped).toHaveBeenCalledWith(req);
    });
  });

  // =========================================================================
  // Indexing delegation
  // =========================================================================

  describe("indexing delegation", () => {
    it("delegates indexCodebase to IngestFacade", async () => {
      const app = createApp(deps);
      const opts = { forceReindex: true };
      const progress = vi.fn();
      await app.indexCodebase("/foo", opts, progress);

      expect(deps.ingest.indexCodebase).toHaveBeenCalledWith("/foo", opts, progress);
    });

    it("delegates reindexChanges to IngestFacade", async () => {
      const app = createApp(deps);
      const progress = vi.fn();
      await app.reindexChanges("/foo", progress);

      expect(deps.ingest.reindexChanges).toHaveBeenCalledWith("/foo", progress);
    });

    it("delegates getIndexStatus to IngestFacade", async () => {
      const app = createApp(deps);
      await app.getIndexStatus("/foo");

      expect(deps.ingest.getIndexStatus).toHaveBeenCalledWith("/foo");
    });

    it("delegates clearIndex to IngestFacade", async () => {
      const app = createApp(deps);
      await app.clearIndex("/foo");

      expect(deps.ingest.clearIndex).toHaveBeenCalledWith("/foo");
    });
  });

  // =========================================================================
  // Collection delegation
  // =========================================================================

  describe("collection delegation", () => {
    it("delegates createCollection to CollectionOps", async () => {
      const app = createApp(deps);
      await app.createCollection({ name: "test" });

      expect(deps.qdrant.createCollection).toHaveBeenCalled();
    });

    it("delegates listCollections to CollectionOps", async () => {
      const app = createApp(deps);
      const result = await app.listCollections();

      expect(deps.qdrant.listCollections).toHaveBeenCalled();
      expect(result).toEqual(["col1", "col2"]);
    });

    it("delegates getCollectionInfo to CollectionOps", async () => {
      const app = createApp(deps);
      const result = await app.getCollectionInfo("test");

      expect(deps.qdrant.getCollectionInfo).toHaveBeenCalledWith("test");
      expect(result.name).toBe("test");
    });

    it("delegates deleteCollection to CollectionOps", async () => {
      const app = createApp(deps);
      await app.deleteCollection("test");

      expect(deps.qdrant.deleteCollection).toHaveBeenCalledWith("test");
    });
  });

  // =========================================================================
  // Document delegation
  // =========================================================================

  describe("document delegation", () => {
    it("delegates addDocuments to DocumentOps", async () => {
      const app = createApp(deps);
      const req = { collection: "test", documents: [{ id: "1", text: "hello" }] };
      const result = await app.addDocuments(req);

      expect(result.count).toBe(1);
    });

    it("delegates deleteDocuments to DocumentOps", async () => {
      const app = createApp(deps);
      const req = { collection: "test", ids: ["1", "2"] };
      const result = await app.deleteDocuments(req);

      expect(deps.qdrant.deletePoints).toHaveBeenCalledWith("test", ["1", "2"]);
      expect(result.count).toBe(2);
    });
  });

  // =========================================================================
  // Schema descriptors
  // =========================================================================

  describe("getSchemaDescriptors", () => {
    it("returns preset names from reranker for all tools", () => {
      const app = createApp(deps);
      const descriptors = app.getSchemaDescriptors();

      expect(descriptors.presetNames).toHaveProperty("semantic_search");
      expect(descriptors.presetNames).toHaveProperty("hybrid_search");
      expect(descriptors.presetNames).toHaveProperty("search_code");
      expect(descriptors.presetNames).toHaveProperty("rank_chunks");
    });

    it("returns signal descriptors from reranker", () => {
      const app = createApp(deps);
      const descriptors = app.getSchemaDescriptors();

      expect(descriptors.signalDescriptors).toHaveLength(2);
      expect(descriptors.signalDescriptors[0]).toEqual({
        name: "recency",
        description: "How recently the code was modified",
      });
    });
  });

  // =========================================================================
  // Drift monitoring
  // =========================================================================

  describe("checkSchemaDrift", () => {
    it("delegates to checkAndConsume when ref has path", async () => {
      const app = createApp(deps);
      await app.checkSchemaDrift({ path: "/foo" });

      expect(deps.schemaDriftMonitor.checkAndConsume).toHaveBeenCalledWith("/foo");
    });

    it("delegates to checkByCollectionName when ref has collection", async () => {
      const app = createApp(deps);
      await app.checkSchemaDrift({ collection: "col1" });

      expect(deps.schemaDriftMonitor.checkByCollectionName).toHaveBeenCalledWith("col1");
    });

    it("returns drift warning from path-based check", async () => {
      (deps.schemaDriftMonitor.checkAndConsume as ReturnType<typeof vi.fn>).mockResolvedValue("Schema drift detected");

      const app = createApp(deps);
      const result = await app.checkSchemaDrift({ path: "/foo" });

      expect(result).toBe("Schema drift detected");
    });

    it("returns drift warning from collection-based check", async () => {
      (deps.schemaDriftMonitor.checkByCollectionName as ReturnType<typeof vi.fn>).mockReturnValue(
        "Schema drift detected",
      );

      const app = createApp(deps);
      const result = await app.checkSchemaDrift({ collection: "col1" });

      expect(result).toBe("Schema drift detected");
    });
  });
});
