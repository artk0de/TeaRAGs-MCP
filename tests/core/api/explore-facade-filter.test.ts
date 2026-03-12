import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/explore-facade.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../src/core/explore/explore-module.js", () => ({
  ExploreModule: class {
    constructor(_q: any, _e: any, _c: any, _r: any, _col: string, _bf?: any) {}
    searchCode = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock("../../../src/core/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit || 5,
    fetchLimit: (limit || 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) => results),
}));

vi.mock("../../../src/core/adapters/qdrant/sparse.js", () => ({
  BM25SparseVectorGenerator: {
    generateSimple: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  },
}));

vi.mock("../../../src/core/explore/rank-module.js", () => ({
  RankModule: class {
    constructor(_reranker: any, _descriptors: any) {}
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    ensurePayloadIndex: vi.fn(),
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
  } as any;
}

function makeMockReranker() {
  return {
    rerank: vi.fn((results: any[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([]),
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(overrides: { qdrant?: any; registry?: any } = {}) {
  const qdrant = overrides.qdrant ?? makeMockQdrant();
  return {
    facade: new ExploreFacade(
      qdrant,
      makeMockEmbeddings(),
      { enableHybridSearch: false, defaultSearchLimit: 5 } as any,
      makeMockReranker(),
      overrides.registry ?? makeMockRegistry(),
      undefined,
      [],
      [],
      undefined,
    ),
    qdrant,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreFacade.buildMergedFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes typed params to registry.buildFilter", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
    });

    expect(registry.buildFilter).toHaveBeenCalledWith(expect.objectContaining({ language: "typescript" }), "chunk");
    expect(qdrant.search).toHaveBeenCalledWith(
      "test",
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({
        must: [{ key: "language", match: { value: "typescript" } }],
      }),
    );
  });

  it("merges typed filter with raw filter", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
      filter: {
        must: [{ key: "relativePath", match: { text: "src/" } }],
      },
    });

    const filterArg = qdrant.search.mock.calls[0][3] as Record<string, unknown>;
    const must = filterArg.must as unknown[];
    expect(must).toHaveLength(2);
    expect(must).toContainEqual({ key: "relativePath", match: { text: "src/" } });
    expect(must).toContainEqual({ key: "language", match: { value: "typescript" } });
  });

  it("preserves raw filter's should and merges must_not", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue({
      must_not: [{ key: "isDocumentation", match: { value: true } }],
    });
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      excludeDocumentation: true,
      filter: {
        should: [{ key: "chunkType", match: { value: "function" } }],
      },
    });

    const filterArg = qdrant.search.mock.calls[0][3] as Record<string, unknown>;
    expect(filterArg.must_not).toEqual([{ key: "isDocumentation", match: { value: true } }]);
    expect(filterArg.should).toEqual([{ key: "chunkType", match: { value: "function" } }]);
  });

  it("returns undefined when no typed or raw filter", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
    });

    expect(qdrant.search).toHaveBeenCalledWith("test", expect.any(Array), expect.any(Number), undefined);
  });

  it("returns raw filter when no typed params match", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    const rawFilter = { must: [{ key: "language", match: { value: "python" } }] };
    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      filter: rawFilter,
    });

    expect(qdrant.search).toHaveBeenCalledWith("test", expect.any(Array), expect.any(Number), rawFilter);
  });

  it("passes level to registry.buildFilter for rankChunks", async () => {
    const registry = makeMockRegistry();
    registry.buildFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.rankChunks({
      collection: "test",
      rerank: { custom: { recency: 1.0 } },
      level: "file",
      language: "typescript",
    });

    expect(registry.buildFilter).toHaveBeenCalledWith(expect.objectContaining({ language: "typescript" }), "file");
  });
});
