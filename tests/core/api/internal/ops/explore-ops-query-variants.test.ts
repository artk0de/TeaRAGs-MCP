/**
 * ExploreOps — several query variants in one semantic_search / hybrid_search
 * call (bd tea-rags-mcp-2vuz). `query` as an array, or a string holding
 * `|||`, embeds every variant in ONE batch call and searches them as one fused
 * request; a plain string keeps the single-query path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { READ_PATH_EMBEDDING_RECOVERY_WAIT_MS } from "../../../../../src/core/adapters/embeddings/base.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn((text: string) => ({ indices: [text.length], values: [0.5] })),
  BM25SparseVectorGenerator: { generateSimple: vi.fn(() => ({ indices: [1], values: [0.5] })) },
}));

const READ_BUDGET = { maxRecoveryWaitMs: READ_PATH_EMBEDDING_RECOVERY_WAIT_MS };
const FUSED = [{ id: "1", score: 0.03, payload: { relativePath: "src/retry.ts", content: "retry" } }];

function makeQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([{ id: "s", score: 0.9, payload: { relativePath: "src/s.ts" } }]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    fusedSearch: vi.fn().mockResolvedValue(FUSED),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    getPoint: vi.fn().mockResolvedValue(null),
  } as any;
}

function makeReranker() {
  return {
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeFacade() {
  const qdrant = makeQdrant();
  const embed = vi.fn().mockResolvedValue({ embedding: [9, 9] });
  const embedBatch = vi
    .fn()
    .mockImplementation(async (texts: string[]) => texts.map((_t, i) => ({ embedding: [i, i], dimensions: 2 })));
  const facade = new ExploreFacade({
    qdrant,
    embeddings: { embed, embedBatch, getDimensions: vi.fn().mockReturnValue(2) } as any,
    reranker: makeReranker(),
    registry: {
      buildFilter: vi.fn().mockReturnValue(undefined),
      buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
      getAllFilters: vi.fn().mockReturnValue([]),
    } as any,
    collectionRegistry: undefined as any,
    payloadSignals: [],
    essentialKeys: [],
  });
  return { facade, qdrant, embed, embedBatch };
}

describe("ExploreOps — query variants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("semantic_search: a '|||' string embeds every variant in ONE batch call and runs ONE fused search", async () => {
    const { facade, qdrant, embed, embedBatch } = makeFacade();

    const response = await facade.semanticSearch({
      collection: "code_x",
      query: "rate limit ||| retry after ||| throttle",
      limit: 3,
    });

    expect(embedBatch).toHaveBeenCalledTimes(1);
    expect(embedBatch).toHaveBeenCalledWith(["rate limit", "retry after", "throttle"], READ_BUDGET);
    expect(embed).not.toHaveBeenCalled();
    expect(qdrant.fusedSearch).toHaveBeenCalledTimes(1);
    expect(qdrant.fusedSearch.mock.calls[0][1]).toEqual([{ dense: [0, 0] }, { dense: [1, 1] }, { dense: [2, 2] }]);
    expect(qdrant.search).not.toHaveBeenCalled();
    expect(response.results.map((r) => r.id)).toEqual(["1"]);
  });

  it("hybrid_search: an array query fuses a dense + sparse leg per variant", async () => {
    const { facade, qdrant, embedBatch } = makeFacade();

    await facade.hybridSearch({ collection: "code_x", query: ["rate limit", "throttle"], limit: 3 });

    expect(embedBatch).toHaveBeenCalledWith(["rate limit", "throttle"], READ_BUDGET);
    expect(qdrant.fusedSearch.mock.calls[0][1]).toEqual([
      { dense: [0, 0], sparse: { indices: [10], values: [0.5] } },
      { dense: [1, 1], sparse: { indices: [8], values: [0.5] } },
    ]);
    expect(qdrant.hybridSearch).not.toHaveBeenCalled();
  });

  it("a plain string query keeps the single-query path: one embed, no batch, no fused search", async () => {
    const { facade, qdrant, embed, embedBatch } = makeFacade();

    await facade.semanticSearch({ collection: "code_x", query: "rate limit", limit: 3 });

    expect(embed).toHaveBeenCalledWith("rate limit", READ_BUDGET);
    expect(embedBatch).not.toHaveBeenCalled();
    expect(qdrant.fusedSearch).not.toHaveBeenCalled();
    expect(qdrant.search).toHaveBeenCalledTimes(1);
  });

  it("a one-element array is the single-query path for that variant", async () => {
    const { facade, qdrant, embed, embedBatch } = makeFacade();

    await facade.semanticSearch({ collection: "code_x", query: ["rate limit"], limit: 3 });

    expect(embed).toHaveBeenCalledWith("rate limit", READ_BUDGET);
    expect(embedBatch).not.toHaveBeenCalled();
    expect(qdrant.fusedSearch).not.toHaveBeenCalled();
  });
});
