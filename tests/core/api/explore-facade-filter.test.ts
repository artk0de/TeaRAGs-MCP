import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(overrides: { qdrant?: any; registry?: any } = {}) {
  const qdrant = overrides.qdrant ?? makeMockQdrant();
  return {
    facade: new ExploreFacade({
      qdrant,
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: overrides.registry ?? makeMockRegistry(),
    }),
    qdrant,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreFacade filter delegation to registry.buildMergedFilter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates typed params and raw filter to registry.buildMergedFilter", async () => {
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue({
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
    });

    expect(registry.buildMergedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript" }),
      undefined, // no raw filter
    );
    expect(qdrant.search).toHaveBeenCalledWith(
      "test",
      expect.any(Array),
      expect.any(Number),
      expect.objectContaining({
        must: [{ key: "language", match: { value: "typescript" } }],
      }),
    );
  });

  it("passes raw filter to registry.buildMergedFilter alongside typed params", async () => {
    const mergedResult = {
      must: [
        { key: "relativePath", match: { text: "src/" } },
        { key: "language", match: { value: "typescript" } },
      ],
    };
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue(mergedResult);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    const rawFilter = { must: [{ key: "relativePath", match: { text: "src/" } }] };
    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      language: "typescript",
      filter: rawFilter,
    });

    expect(registry.buildMergedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript" }),
      rawFilter,
    );
    const filterArg = qdrant.search.mock.calls[0][3] as Record<string, unknown>;
    const must = filterArg.must as unknown[];
    expect(must).toHaveLength(2);
  });

  it("returns undefined when registry.buildMergedFilter returns undefined", async () => {
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
    });

    expect(qdrant.search).toHaveBeenCalledWith("test", expect.any(Array), expect.any(Number), undefined);
  });

  it("passes raw filter through when registry returns it unchanged", async () => {
    const rawFilter = { must: [{ key: "language", match: { value: "python" } }] };
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue(rawFilter);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.semanticSearch({
      collection: "test",
      query: "test query",
      filter: rawFilter,
    });

    expect(qdrant.search).toHaveBeenCalledWith("test", expect.any(Array), expect.any(Number), rawFilter);
  });

  it("passes level to registry.buildMergedFilter for rankChunks", async () => {
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.rankChunks({
      collection: "test",
      rerank: { custom: { recency: 1.0 } },
      level: "file",
      language: "typescript",
    });

    expect(registry.buildMergedFilter).toHaveBeenCalledWith(
      expect.objectContaining({ language: "typescript" }),
      undefined, // no raw filter
      "file",
    );
  });
});
