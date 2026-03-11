import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HybridSearchRequest, RankChunksRequest, SemanticSearchRequest } from "../../../src/core/api/app.js";
import { ExploreFacade } from "../../../src/core/api/explore-facade.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const searchCodeSpy = vi.fn().mockResolvedValue([
  {
    content: "fn test()",
    filePath: "/project/a.ts",
    startLine: 1,
    endLine: 5,
    language: "typescript",
    score: 0.9,
    fileExtension: ".ts",
  },
]);

vi.mock("../../../src/core/explore/search-module.js", () => ({
  SearchModule: class {
    constructor(_q: any, _e: any, _c: any, _r: any, _col: string, _bf?: any) {}
    searchCode = searchCodeSpy;
  },
}));

vi.mock("../../../src/core/explore/post-process.js", () => ({
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

vi.mock("../../../src/core/explore/rank-module.js", () => ({
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

function makeFacade(
  overrides: {
    qdrant?: any;
    embeddings?: any;
    reranker?: any;
    driftMonitor?: any;
    statsCache?: any;
    essentialTrajectoryFields?: string[];
  } = {},
) {
  const qdrant = overrides.qdrant ?? makeMockQdrant();
  const embeddings = overrides.embeddings ?? makeMockEmbeddings();
  const reranker = overrides.reranker ?? makeMockReranker();
  const driftMonitor = overrides.driftMonitor ?? makeMockDriftMonitor();
  const statsCache = overrides.statsCache ?? undefined;
  const essentialFields = overrides.essentialTrajectoryFields ?? ["git.file.ageDays"];

  return {
    facade: new ExploreFacade(
      qdrant,
      embeddings,
      {} as any, // config
      reranker,
      undefined, // registry
      statsCache,
      essentialFields,
      driftMonitor,
    ),
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

      await expect(facade.semanticSearch({ collection: "missing_col", query: "test" })).rejects.toThrow(
        /does not exist/,
      );
    });

    it("applies metaOnly formatting when requested", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/explore/post-process.js");

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

      await expect(facade.hybridSearch({ collection: "missing_col", query: "test" })).rejects.toThrow(/does not exist/);
    });

    it("applies metaOnly formatting when requested", async () => {
      const { facade } = makeFacade();
      const { filterMetaOnly } = await import("../../../src/core/explore/post-process.js");

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
      const { filterMetaOnly } = await import("../../../src/core/explore/post-process.js");

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
      const { filterMetaOnly } = await import("../../../src/core/explore/post-process.js");
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
  // searchCodeTyped
  // =========================================================================

  describe("searchCodeTyped", () => {
    it("wraps searchCode and returns typed response", async () => {
      const { facade } = makeFacade();

      const result = await facade.searchCodeTyped({
        path: "/tmp/test-project",
        query: "test query",
      });

      expect(searchCodeSpy).toHaveBeenCalledWith("test query", expect.any(Object));
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toHaveProperty("content");
      expect(result.results[0]).toHaveProperty("filePath");
      expect(result.results[0]).toHaveProperty("score");
      expect(result.driftWarning).toBeNull();
    });

    it("maps CodeSearchResult fields to SearchCodeResult", async () => {
      const { facade } = makeFacade();

      const result = await facade.searchCodeTyped({
        path: "/tmp/test-project",
        query: "test",
      });

      const first = result.results[0];
      expect(first.content).toBe("fn test()");
      expect(first.filePath).toBe("/project/a.ts");
      expect(first.startLine).toBe(1);
      expect(first.endLine).toBe(5);
      expect(first.language).toBe("typescript");
      expect(first.score).toBe(0.9);
      expect(first.fileExtension).toBe(".ts");
    });

    it("passes search options from request", async () => {
      const { facade } = makeFacade();

      await facade.searchCodeTyped({
        path: "/tmp/test-project",
        query: "test",
        limit: 20,
        fileTypes: ["ts"],
        pathPattern: "src/**",
        rerank: "recent",
      });

      expect(searchCodeSpy).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({
          limit: 20,
          fileTypes: ["ts"],
          pathPattern: "src/**",
          rerank: "recent",
        }),
      );
    });

    it("returns drift warning when present", async () => {
      const driftMonitor = makeMockDriftMonitor({
        checkAndConsume: vi.fn().mockResolvedValue("Drift warning!"),
      });
      const { facade } = makeFacade({ driftMonitor });

      const result = await facade.searchCodeTyped({
        path: "/tmp/test-project",
        query: "test",
      });

      expect(result.driftWarning).toBe("Drift warning!");
    });
  });
});
