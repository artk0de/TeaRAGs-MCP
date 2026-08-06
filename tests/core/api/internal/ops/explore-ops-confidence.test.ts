/**
 * ExploreOps — search-confidence envelope wiring.
 *
 * Confidence answers "does the project contain this at all", so it rides the
 * response envelope of the tools whose score is a genuine similarity —
 * semantic_search and find_similar. It MUST NOT appear on:
 *   - hybrid_search: RRF fusion emits rank-derived scores (0.5, 0.333, 0.25 …),
 *     a magnitude that says nothing about the match
 *   - rank_chunks: scroll + rerank, every candidate is already known to be there
 *   - find_symbol: exact lookup, the question does not arise
 *
 * It also requires the collection's similarity scale; without it the field is
 * omitted rather than guessed.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";

// ---------------------------------------------------------------------------
// Module mocks — mirror explore-ops.test.ts exactly.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixtures — scores far above the collection background vs scores near it.
// ---------------------------------------------------------------------------

const STRONG = [
  { id: "1", score: 0.82, payload: { relativePath: "src/core/domains/explore/reranker.ts" } },
  { id: "2", score: 0.65, payload: { relativePath: "src/core/domains/explore/post-process.ts" } },
  { id: "3", score: 0.62, payload: { relativePath: "src/core/domains/explore/label-resolver.ts" } },
  { id: "4", score: 0.58, payload: { relativePath: "src/core/domains/explore/reranker.ts" } },
  { id: "5", score: 0.55, payload: { relativePath: "src/core/domains/explore/signal-floors.ts" } },
];

const WEAK = [
  { id: "1", score: 0.473, payload: { relativePath: "src/core/adapters/qdrant/client.ts" } },
  { id: "2", score: 0.466, payload: { relativePath: "src/cli/commands/doctor.ts" } },
  { id: "3", score: 0.462, payload: { relativePath: "src/mcp/tools/explore.ts" } },
  { id: "4", score: 0.458, payload: { relativePath: "website/docs/api/tools.md" } },
  { id: "5", score: 0.451, payload: { relativePath: "src/core/infra/errors.ts" } },
];

// ---------------------------------------------------------------------------
// Mock factories — spread+override pattern from explore-ops.test.ts.
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue([]),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    scrollAll: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;
}

/** Stand-in collection scale: background similarity 0.25 ± 0.15. */
const BACKGROUND = { mean: 0.25, stddev: 0.15, sampleCount: 600 };

function makeMockReranker(overrides: Record<string, any> = {}) {
  return {
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getCollectionStats: vi.fn().mockReturnValue({ scoreBackground: BACKGROUND }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
    ...overrides,
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getFilterPresetDef: vi.fn().mockReturnValue(undefined),
  } as any;
}

function makeMockCollectionRegistry() {
  return {
    findByName: vi.fn().mockReturnValue(null),
    findByPath: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as any;
}

function makeOps(qdrant: any, reranker = makeMockReranker()) {
  return new ExploreOps({
    qdrant,
    embeddings: makeMockEmbeddings(),
    reranker,
    registry: makeMockRegistry(),
    collectionRegistry: makeMockCollectionRegistry(),
    payloadSignals: [],
    essentialKeys: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreOps — search confidence on the response envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tools whose score is a genuine similarity", () => {
    it("semanticSearch reports strong hits above low and background-level hits as low", async () => {
      const strong = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(STRONG) })).semanticSearch({
        query: "reranker adaptive bounds",
        collection: "code_test_col",
      } as never);
      const weak = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(WEAK) })).semanticSearch({
        query: "quantum blockchain orchestration",
        collection: "code_test_col",
      } as never);

      expect(weak.confidence?.label).toBe("low");
      expect(strong.confidence?.label).not.toBe("low");
      expect(strong.confidence!.value).toBeGreaterThan(weak.confidence!.value);
    });

    it("omits confidence when the collection has no measured similarity scale", async () => {
      const noBackground = makeMockReranker({ getCollectionStats: vi.fn().mockReturnValue(undefined) });
      const ops = makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(STRONG) }), noBackground);

      const response = await ops.semanticSearch({ query: "anything", collection: "code_test_col" } as never);

      expect(response.confidence).toBeUndefined();
      expect(response.results).toHaveLength(STRONG.length);
    });
  });

  describe("tools whose score does not attest a match", () => {
    it("findSimilar omits confidence — its query is code, on a different scale from the cut-points", async () => {
      // Measured: within-leg AUC 1.000, but unrelated CODE sits far closer to a
      // code corpus than unrelated prose does, so the shared cut-points label
      // 10/10 nonsense snippets "high". Out of scope until it has its own
      // calibration corpus.
      const ops = makeOps(makeMockQdrant({ query: vi.fn().mockResolvedValue(STRONG) }));
      const request = { positiveIds: ["1"], collection: "code_test_col" } as never;

      const response = await ops.findSimilar(request, ops.buildSimilarStrategy(request));

      expect(response.confidence).toBeUndefined();
    });

    it("hybridSearch omits confidence — RRF fusion emits rank-derived scores", async () => {
      const response = await makeOps(makeMockQdrant({ hybridSearch: vi.fn().mockResolvedValue(STRONG) })).hybridSearch({
        query: "reranker adaptive bounds",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeUndefined();
    });

    it("rankChunks omits confidence entirely", async () => {
      const response = await makeOps(makeMockQdrant({ scrollAll: vi.fn().mockResolvedValue(WEAK) })).rankChunks({
        rerank: "techDebt",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeUndefined();
    });

    it("findSymbol omits confidence entirely", async () => {
      const response = await makeOps(makeMockQdrant({ scrollFiltered: vi.fn().mockResolvedValue(STRONG) })).findSymbol({
        symbol: "Reranker",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeUndefined();
    });
  });

  describe("no gating", () => {
    it("returns every result even when confidence is low", async () => {
      const response = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(WEAK) })).semanticSearch({
        query: "quantum blockchain orchestration",
        collection: "code_test_col",
      } as never);

      expect(response.confidence!.label).toBe("low");
      expect(response.results).toHaveLength(WEAK.length);
    });
  });
});
