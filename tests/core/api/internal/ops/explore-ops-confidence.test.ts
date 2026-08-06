/**
 * ExploreOps — search-confidence envelope wiring.
 *
 * Confidence answers "does the project contain this at all", so it rides the
 * response envelope of the three tools whose score carries semantic evidence
 * (semantic_search, hybrid_search, find_similar) and MUST NOT appear on
 * rank_chunks (scroll + rerank: every candidate is already known to be there)
 * or find_symbol (exact lookup).
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
// Fixtures — a peaked, clustered hit set vs a flat, scattered one.
// ---------------------------------------------------------------------------

const PEAKED = [
  { id: "1", score: 0.82, payload: { relativePath: "src/core/domains/explore/reranker.ts" } },
  { id: "2", score: 0.54, payload: { relativePath: "src/core/domains/explore/post-process.ts" } },
  { id: "3", score: 0.51, payload: { relativePath: "src/core/domains/explore/label-resolver.ts" } },
  { id: "4", score: 0.49, payload: { relativePath: "src/core/domains/explore/reranker.ts" } },
  { id: "5", score: 0.47, payload: { relativePath: "src/core/domains/explore/signal-floors.ts" } },
];

const FLAT = [
  { id: "1", score: 0.553, payload: { relativePath: "src/core/adapters/qdrant/client.ts" } },
  { id: "2", score: 0.551, payload: { relativePath: "src/cli/commands/doctor.ts" } },
  { id: "3", score: 0.55, payload: { relativePath: "src/mcp/tools/explore.ts" } },
  { id: "4", score: 0.549, payload: { relativePath: "website/docs/api/tools.md" } },
  { id: "5", score: 0.548, payload: { relativePath: "src/core/infra/errors.ts" } },
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

function makeMockReranker(overrides: Record<string, any> = {}) {
  return {
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
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

function makeOps(qdrant: any) {
  return new ExploreOps({
    qdrant,
    embeddings: makeMockEmbeddings(),
    reranker: makeMockReranker(),
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

  describe("tools that carry semantic evidence", () => {
    it("semanticSearch reports high-shape hits above low and flat hits as low", async () => {
      const peaked = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(PEAKED) })).semanticSearch({
        query: "reranker adaptive bounds",
        collection: "code_test_col",
      } as never);
      const flat = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(FLAT) })).semanticSearch({
        query: "quantum blockchain orchestration",
        collection: "code_test_col",
      } as never);

      expect(flat.confidence?.label).toBe("low");
      expect(peaked.confidence?.label).not.toBe("low");
      expect(peaked.confidence!.value).toBeGreaterThan(flat.confidence!.value);
    });

    it("hybridSearch carries confidence", async () => {
      const response = await makeOps(makeMockQdrant({ hybridSearch: vi.fn().mockResolvedValue(PEAKED) })).hybridSearch({
        query: "reranker adaptive bounds",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeDefined();
      expect(["low", "medium", "high"]).toContain(response.confidence!.label);
    });

    it("findSimilar carries confidence", async () => {
      const ops = makeOps(makeMockQdrant({ query: vi.fn().mockResolvedValue(PEAKED) }));
      const request = { positiveIds: ["1"], collection: "code_test_col" } as never;

      const response = await ops.findSimilar(request, ops.buildSimilarStrategy(request));

      expect(response.confidence).toBeDefined();
    });
  });

  describe("tools whose score does not attest a match", () => {
    it("rankChunks omits confidence entirely", async () => {
      const response = await makeOps(makeMockQdrant({ scrollAll: vi.fn().mockResolvedValue(FLAT) })).rankChunks({
        rerank: "techDebt",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeUndefined();
    });

    it("findSymbol omits confidence entirely", async () => {
      const response = await makeOps(makeMockQdrant({ scrollFiltered: vi.fn().mockResolvedValue(PEAKED) })).findSymbol({
        symbol: "Reranker",
        collection: "code_test_col",
      } as never);

      expect(response.confidence).toBeUndefined();
    });
  });

  describe("no gating", () => {
    it("returns every result even when confidence is low", async () => {
      const response = await makeOps(makeMockQdrant({ search: vi.fn().mockResolvedValue(FLAT) })).semanticSearch({
        query: "quantum blockchain orchestration",
        collection: "code_test_col",
      } as never);

      expect(response.confidence!.label).toBe("low");
      expect(response.results).toHaveLength(FLAT.length);
    });
  });
});
