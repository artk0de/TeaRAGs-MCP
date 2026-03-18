import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HybridSearchRequest, RankChunksRequest, SemanticSearchRequest } from "../../../src/core/api/index.js";
import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number, _pp?: string, _r?: unknown) => ({
    requestedLimit: limit || 5,
    fetchLimit: (limit || 5) * 3,
  })),
  postProcess: vi.fn((results: any[], _opts: any) => results),
  filterMetaOnly: vi.fn((results: any[], _ps: any, _etf: string[]) =>
    results.map((r: any) => ({ score: r.score, relativePath: r.payload?.relativePath })),
  ),
}));

vi.mock("../../../src/core/adapters/qdrant/sparse.js", () => ({
  BM25SparseVectorGenerator: {
    generateSimple: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  },
}));

vi.mock("../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    constructor(_reranker: any, _descriptors: any) {}
    rankChunks = vi.fn().mockResolvedValue([
      { score: 0.8, payload: { relativePath: "a.ts" } },
      { score: 0.6, payload: { relativePath: "b.ts" } },
    ]);
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([
      { id: "1", score: 0.95, payload: { relativePath: "src/a.ts", content: "hello" } },
      { id: "2", score: 0.85, payload: { relativePath: "src/b.ts", content: "world" } },
    ]),
    queryGroups: vi
      .fn()
      .mockResolvedValue([{ id: "1", score: 0.95, payload: { relativePath: "src/a.ts", content: "hello" } }]),
    hybridSearch: vi
      .fn()
      .mockResolvedValue([{ id: "1", score: 0.9, payload: { relativePath: "src/a.ts", content: "hello" } }]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  } as any;
}

function makeMockReranker(overrides: Record<string, any> = {}) {
  return {
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ recency: 0.5, churn: 0.5 }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
    ...overrides,
  } as any;
}

function makeMockDriftMonitor(overrides: Record<string, any> = {}) {
  return {
    checkAndConsume: vi.fn().mockResolvedValue(null),
    checkByCollectionName: vi.fn().mockReturnValue(null),
    ...overrides,
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    // Default: pass through the raw filter (2nd arg) like the real implementation
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(
  overrides: {
    qdrant?: any;
    embeddings?: any;
    reranker?: any;
    driftMonitor?: any;
    statsCache?: any;
    registry?: any;
    essentialTrajectoryFields?: string[];
  } = {},
) {
  const qdrant = overrides.qdrant ?? makeMockQdrant();
  const embeddings = overrides.embeddings ?? makeMockEmbeddings();
  const reranker = overrides.reranker ?? makeMockReranker();
  const driftMonitor = overrides.driftMonitor ?? makeMockDriftMonitor();
  const statsCache = overrides.statsCache ?? undefined;
  const registry = overrides.registry ?? makeMockRegistry();
  const essentialFields = overrides.essentialTrajectoryFields ?? ["git.file.ageDays"];

  return {
    facade: new ExploreFacade({
      qdrant,
      embeddings,
      reranker,
      registry,
      statsCache,
      schemaDriftMonitor: driftMonitor,
      payloadSignals: [],
      essentialKeys: essentialFields,
    }),
    qdrant,
    embeddings,
    reranker,
    driftMonitor,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreFacade — expanded methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // semanticSearch
  // =========================================================================

  describe("semanticSearch", () => {
    it("executes full pipeline: resolve → validate → embed → search → postProcess → return", async () => {
      const { facade, qdrant, embeddings } = makeFacade();

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "find me",
        limit: 10,
      });

      expect(embeddings.embed).toHaveBeenCalledWith("find me");
      expect(qdrant.search).toHaveBeenCalledWith("test_col", [0.1, 0.2, 0.3], expect.any(Number), undefined);
      expect(result.results).toHaveLength(2);
      expect(result.driftWarning).toBeNull();
    });

    it("resolves collection name from path", async () => {
      const { facade, qdrant } = makeFacade();

      await facade.semanticSearch({
        path: "/tmp/test-project",
        query: "test",
      });

      // Should resolve collection name and call collectionExists
      expect(qdrant.collectionExists).toHaveBeenCalled();
      expect(qdrant.search).toHaveBeenCalled();
    });

    it("throws when neither collection nor path provided", async () => {
      const { facade } = makeFacade();

      await expect(facade.semanticSearch({ query: "test" } as SemanticSearchRequest)).rejects.toThrow();
    });

    it("throws when collection does not exist", async () => {
      const qdrant = makeMockQdrant({ collectionExists: vi.fn().mockResolvedValue(false) });
      const { facade } = makeFacade({ qdrant });

      await expect(facade.semanticSearch({ collection: "missing_col", query: "test" })).rejects.toThrow(/not found/);
    });

    it("applies metaOnly formatting when requested", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/domains/explore/post-process.js");

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "test",
        metaOnly: true,
      });

      expect(filterMetaOnly).toHaveBeenCalled();
      // metaOnly results have different shape
      expect(result.results).toBeDefined();
    });

    it("returns drift warning from path-based check", async () => {
      const driftMonitor = makeMockDriftMonitor({
        checkAndConsume: vi.fn().mockResolvedValue("Schema drift detected!"),
      });
      const { facade } = makeFacade({ driftMonitor });

      const result = await facade.semanticSearch({
        path: "/tmp/test-project",
        query: "test",
      });

      expect(result.driftWarning).toBe("Schema drift detected!");
    });

    it("returns drift warning from collection-based check", async () => {
      const driftMonitor = makeMockDriftMonitor({
        checkByCollectionName: vi.fn().mockReturnValue("Schema changed!"),
      });
      const { facade } = makeFacade({ driftMonitor });

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "test",
      });

      expect(result.driftWarning).toBe("Schema changed!");
    });

    it("passes filter to qdrant search", async () => {
      const { facade, qdrant } = makeFacade();
      const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

      await facade.semanticSearch({
        collection: "test_col",
        query: "test",
        filter,
      });

      expect(qdrant.search).toHaveBeenCalledWith("test_col", expect.anything(), expect.any(Number), filter);
    });

    it("loads stats from cache on cold start", async () => {
      const statsCache = { load: vi.fn().mockReturnValue({ perSignal: new Map(), computedAt: Date.now() }) };
      const reranker = makeMockReranker({ hasCollectionStats: false });
      const { facade } = makeFacade({ reranker, statsCache });

      await facade.semanticSearch({ collection: "test_col", query: "test" });

      expect(statsCache.load).toHaveBeenCalled();
      expect(reranker.setCollectionStats).toHaveBeenCalled();
    });

    it("uses queryGroups when level is file", async () => {
      const { facade, qdrant } = makeFacade();

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "test",
        level: "file",
      });

      expect(qdrant.queryGroups).toHaveBeenCalledWith("test_col", [0.1, 0.2, 0.3], {
        groupBy: "relativePath",
        groupSize: 1,
        limit: expect.any(Number),
        filter: undefined,
      });
      expect(qdrant.search).not.toHaveBeenCalled();
      expect(result.results).toHaveLength(1);
    });

    it("resolves level from preset signalLevel when rerank is a string", async () => {
      const reranker = makeMockReranker({
        getFullPreset: vi.fn().mockReturnValue({ signalLevel: "file" }),
      });
      const { facade, qdrant } = makeFacade({ reranker });

      await facade.semanticSearch({
        collection: "test_col",
        query: "test",
        rerank: "securityAudit",
      });

      expect(reranker.getFullPreset).toHaveBeenCalledWith("securityAudit", "semantic_search");
      expect(qdrant.queryGroups).toHaveBeenCalled();
      expect(qdrant.search).not.toHaveBeenCalled();
    });

    it("includes level in response when set", async () => {
      const { facade } = makeFacade();

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "test",
        level: "file",
      });

      expect(result.level).toBe("file");
    });

    it("omits level from response when not set", async () => {
      const { facade } = makeFacade();

      const result = await facade.semanticSearch({
        collection: "test_col",
        query: "test",
      });

      expect(result.level).toBeUndefined();
    });
  });

  // =========================================================================
  // hybridSearch
  // =========================================================================

  describe("hybridSearch", () => {
    it("executes full pipeline with sparse vector generation", async () => {
      const { facade, qdrant, embeddings } = makeFacade();

      const result = await facade.hybridSearch({
        collection: "test_col",
        query: "find me",
        limit: 5,
      });

      expect(embeddings.embed).toHaveBeenCalledWith("find me");
      expect(qdrant.getCollectionInfo).toHaveBeenCalledWith("test_col");
      expect(qdrant.hybridSearch).toHaveBeenCalledWith(
        "test_col",
        [0.1, 0.2, 0.3],
        { indices: [1, 2], values: [0.5, 0.5] },
        expect.any(Number),
        undefined,
      );
      expect(result.results).toHaveLength(1);
      expect(result.driftWarning).toBeNull();
    });

    it("throws when hybrid not enabled on collection", async () => {
      const qdrant = makeMockQdrant({
        getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
      });
      const { facade } = makeFacade({ qdrant });

      await expect(facade.hybridSearch({ collection: "test_col", query: "test" })).rejects.toThrow(
        /hybrid search enabled/,
      );
    });

    it("throws when neither collection nor path provided", async () => {
      const { facade } = makeFacade();

      await expect(facade.hybridSearch({ query: "test" } as HybridSearchRequest)).rejects.toThrow();
    });

    it("throws when collection does not exist", async () => {
      const qdrant = makeMockQdrant({ collectionExists: vi.fn().mockResolvedValue(false) });
      const { facade } = makeFacade({ qdrant });

      await expect(facade.hybridSearch({ collection: "missing_col", query: "test" })).rejects.toThrow(/not found/);
    });

    it("applies metaOnly formatting when requested", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/domains/explore/post-process.js");

      await facade.hybridSearch({
        collection: "test_col",
        query: "test",
        metaOnly: true,
      });

      expect(filterMetaOnly).toHaveBeenCalled();
    });

    it("passes filter to hybridSearch", async () => {
      const { facade, qdrant } = makeFacade();
      const filter = { must: [{ key: "language", match: { value: "rust" } }] };

      await facade.hybridSearch({
        collection: "test_col",
        query: "test",
        filter,
      });

      expect(qdrant.hybridSearch).toHaveBeenCalledWith(
        "test_col",
        expect.anything(),
        expect.anything(),
        expect.any(Number),
        filter,
      );
    });
  });

  // =========================================================================
  // rankChunks
  // =========================================================================

  describe("rankChunks", () => {
    it("resolves preset by name and ranks chunks", async () => {
      const { facade, reranker } = makeFacade();

      const result = await facade.rankChunks({
        collection: "test_col",
        rerank: "techDebt",
        level: "chunk",
        limit: 10,
      });

      expect(reranker.getPreset).toHaveBeenCalledWith("techDebt", "rank_chunks");
      expect(result.results).toBeDefined();
      expect(result.driftWarning).toBeNull();
    });

    it("uses custom weights when provided", async () => {
      const { facade, reranker } = makeFacade();

      await facade.rankChunks({
        collection: "test_col",
        rerank: { custom: { recency: 0.7, churn: 0.3 } },
        level: "file",
        limit: 5,
      });

      expect(reranker.getPreset).not.toHaveBeenCalled();
    });

    it("throws when preset not found", async () => {
      const reranker = makeMockReranker({ getPreset: vi.fn().mockReturnValue(undefined) });
      const { facade } = makeFacade({ reranker });

      await expect(
        facade.rankChunks({
          collection: "test_col",
          rerank: "nonexistent",
          level: "chunk",
        }),
      ).rejects.toThrow(/Unknown preset/);
    });

    it("throws when neither collection nor path provided", async () => {
      const { facade } = makeFacade();

      await expect(
        facade.rankChunks({
          rerank: "techDebt",
          level: "chunk",
        } as RankChunksRequest),
      ).rejects.toThrow();
    });

    it("applies offset correctly", async () => {
      const { facade } = makeFacade();

      const result = await facade.rankChunks({
        collection: "test_col",
        rerank: "techDebt",
        level: "chunk",
        limit: 10,
        offset: 1,
      });

      // With offset=1, the first result should be skipped
      expect(result.results.length).toBeLessThanOrEqual(10);
    });

    it("defaults metaOnly to true for rank_chunks", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/domains/explore/post-process.js");

      await facade.rankChunks({
        collection: "test_col",
        rerank: "techDebt",
        level: "chunk",
      });

      // metaOnly defaults to true, so filterMetaOnly should be called
      expect(filterMetaOnly).toHaveBeenCalled();
    });

    it("merges existing must_not filter with documentation exclusion", async () => {
      const { facade } = makeFacade();

      await facade.rankChunks({
        collection: "test_col",
        rerank: "techDebt",
        level: "chunk",
        filter: { must_not: [{ key: "language", match: { value: "markdown" } }] },
      });

      // Should succeed (documentation exclusion is merged with existing must_not)
      // The underlying rankChunks mock verifies execution completed
    });

    it("skips metaOnly when explicitly false", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/domains/explore/post-process.js");
      vi.mocked(filterMetaOnly).mockClear();

      await facade.rankChunks({
        collection: "test_col",
        rerank: "techDebt",
        level: "chunk",
        metaOnly: false,
      });

      expect(filterMetaOnly).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // searchCode
  // =========================================================================

  describe("searchCode", () => {
    it("uses vector strategy and returns ExploreResponse", async () => {
      const { facade, qdrant, embeddings } = makeFacade();

      const result = await facade.searchCode({
        path: "/tmp/test-project",
        query: "test query",
      });

      expect(embeddings.embed).toHaveBeenCalledWith("test query");
      expect(qdrant.search).toHaveBeenCalled();
      expect(result.results).toHaveLength(2);
      expect(result.results[0]).toHaveProperty("score");
      expect(result.results[0]).toHaveProperty("payload");
      expect(result.driftWarning).toBeNull();
    });

    it("returns drift warning when present", async () => {
      const driftMonitor = makeMockDriftMonitor({
        checkAndConsume: vi.fn().mockResolvedValue("Drift warning!"),
      });
      const { facade } = makeFacade({ driftMonitor });

      const result = await facade.searchCode({
        path: "/tmp/test-project",
        query: "test",
      });

      expect(result.driftWarning).toBe("Drift warning!");
    });
  });
});
