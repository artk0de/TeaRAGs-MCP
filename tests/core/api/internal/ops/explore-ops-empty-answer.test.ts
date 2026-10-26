/**
 * ExploreOps — empty hybrid_search / semantic_search answers explain themselves
 * (agent turn economy N6, bd tea-rags-mcp-wrosj). The diagnosis runs ONLY on an
 * empty answer: a non-empty one sends no extra Qdrant request and carries no
 * `empty` field.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";

// Module mocks — mirror explore-ops-preset-filter-notice.test.ts.
vi.mock("../../../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit ?? 5,
    fetchLimit: (limit ?? 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) =>
    results.map((r: any) => ({ score: r.score, relativePath: r.payload?.relativePath })),
  ),
}));

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1], values: [0.5] })),
  BM25SparseVectorGenerator: { generateSimple: vi.fn(() => ({ indices: [1], values: [0.5] })) },
}));

const HITS = [{ id: "1", score: 0.7, payload: { relativePath: "src/core/domains/explore/reranker.ts" } }];
const USER_FILTER = { must: [{ key: "language", match: { value: "cobol" } }] };

function makeMockQdrant(hits: unknown[]) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue(hits),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue(hits),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue(hits),
    query: vi.fn().mockResolvedValue(hits),
    scrollAll: vi.fn().mockResolvedValue([]),
    countPoints: vi.fn().mockResolvedValue(7),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeOps(qdrant: any) {
  return new ExploreOps({
    qdrant,
    embeddings: {
      embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
      embedBatch: vi.fn().mockResolvedValue([{ embedding: [0.1, 0.2, 0.3] }]),
      getDimensions: vi.fn().mockReturnValue(3),
    } as any,
    reranker: {
      hasCollectionStats: false,
      hasCollectionStatsFor: vi.fn().mockReturnValue(false),
      setCollectionStats: vi.fn(),
      getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
      getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
      getCollectionStats: vi.fn().mockReturnValue(undefined),
      getDescriptors: vi.fn().mockReturnValue([]),
      rerank: vi.fn((results: any[]) => results),
    } as any,
    registry: {
      buildFilter: vi.fn().mockReturnValue(undefined),
      buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
      getAllFilters: vi.fn().mockReturnValue([]),
      getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
      getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      getFilterPresetDef: vi.fn().mockReturnValue(undefined),
    } as any,
    collectionRegistry: {
      findByName: vi.fn().mockReturnValue(null),
      findByPath: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
    } as any,
    payloadSignals: [],
    essentialKeys: [],
  });
}

describe("ExploreOps — empty answer explanation (N6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("semantic_search: an empty answer whose filter removed every point says filteredOut", async () => {
    const response = await makeOps(makeMockQdrant([])).semanticSearch({
      collection: "code_test_col",
      query: "parser",
      filter: USER_FILTER,
    });

    expect(response.results).toEqual([]);
    expect(response.empty).toMatchObject({ reason: "filteredOut", suggestions: ["filter: {}"] });
  });

  it("hybrid_search: an empty answer with nothing narrowing it says noMatch", async () => {
    const response = await makeOps(makeMockQdrant([])).hybridSearch({ collection: "code_test_col", query: "parser" });

    expect(response.empty?.reason).toBe("noMatch");
  });

  it("a non-empty answer carries no empty field and sends no diagnostic count", async () => {
    const qdrant = makeMockQdrant(HITS);
    const semantic = await makeOps(qdrant).semanticSearch({
      collection: "code_test_col",
      query: "parser",
      filter: USER_FILTER,
    });
    const hybrid = await makeOps(qdrant).hybridSearch({
      collection: "code_test_col",
      query: "parser",
      filter: USER_FILTER,
    });

    expect(semantic.results.length).toBeGreaterThan(0);
    expect(hybrid.results.length).toBeGreaterThan(0);
    expect("empty" in semantic).toBe(false);
    expect("empty" in hybrid).toBe(false);
    expect(qdrant.countPoints).not.toHaveBeenCalled();
  });
});
