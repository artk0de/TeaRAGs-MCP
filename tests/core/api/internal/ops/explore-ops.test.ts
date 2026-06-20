/**
 * ExploreOps — chunkResolver threading test.
 *
 * Verifies that when ExploreOps receives a `chunkResolver` in its deps,
 * that resolver is threaded into SymbolSearchStrategy so the
 * resolveViaCodegraph fallback path can fire when the primary Qdrant
 * scroll returns empty results.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";

// ---------------------------------------------------------------------------
// Module mocks — mirror explore-ops-edges.test.ts exactly.
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
// Mock factories — spread+override pattern from explore-ops-edges.test.ts.
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue([]),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue([]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
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
  } as any;
}

function makeMockCollectionRegistry() {
  return {
    findByName: vi.fn().mockReturnValue(null),
    findByPath: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreOps.findSymbol", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes chunkResolver into SymbolSearchStrategy so resolveViaCodegraph fires on empty scroll", async () => {
    // Arrange: a mock chunkResolver (resolveSymbolChunk returns null — no
    // codegraph chunk found). scrollFiltered returns [] on both passes so
    // the primary + parent scroll produces nothing and the strategy falls
    // through to resolveViaCodegraph, which calls resolveSymbolChunk.
    const chunkResolver = { resolveSymbolChunk: vi.fn().mockResolvedValue(null) };

    const ops = new ExploreOps({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: makeMockRegistry(),
      collectionRegistry: makeMockCollectionRegistry(),
      payloadSignals: [],
      essentialKeys: [],
      chunkResolver,
    });

    // Act: findSymbol with collection (bypasses registry lookup) + a symbol
    // that has no Qdrant chunks (scroll → []) so the codegraph fallback runs.
    await ops.findSymbol({ symbol: "Foo#bar", collection: "code_test_col" } as never);

    // Assert: the resolver was consulted with the collection name and the
    // exact symbol string the caller passed in.
    expect(chunkResolver.resolveSymbolChunk).toHaveBeenCalledWith(expect.any(String), "Foo#bar");
  });
});
