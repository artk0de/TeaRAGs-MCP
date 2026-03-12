import { describe, expect, it, vi } from "vitest";

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

function createMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
    search: vi.fn().mockResolvedValue([
      {
        id: "1",
        score: 0.9,
        payload: {
          content: "function hello() {}",
          relativePath: "src/hello.ts",
          startLine: 1,
          endLine: 3,
          language: "typescript",
          fileExtension: ".ts",
        },
      },
    ]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    ensurePayloadIndex: vi.fn(),
  } as any;
}

function createMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2] }),
  } as any;
}

function createMockReranker() {
  return {
    rerank: vi.fn((results: any[]) => results),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getPreset: vi.fn(),
    getPresetNames: vi.fn().mockReturnValue([]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
  } as any;
}

function createMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
  } as any;
}

function makeFacade(overrides: { qdrant?: any; registry?: any } = {}) {
  return new ExploreFacade(
    overrides.qdrant ?? createMockQdrant(),
    createMockEmbeddings(),
    { enableHybridSearch: false, defaultSearchLimit: 5 } as any,
    createMockReranker(),
    overrides.registry ?? createMockRegistry(),
    undefined,
    [],
    [],
    undefined,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreFacade.exploreCode", () => {
  it("returns ExploreResponse with payload containing content", async () => {
    const facade = makeFacade();
    const response = await facade.exploreCode({
      path: "/test/project",
      query: "hello function",
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].score).toBe(0.9);
    expect(response.results[0].payload?.relativePath).toBe("src/hello.ts");
    expect(response.results[0].payload?.content).toBe("function hello() {}");
    expect(response.driftWarning).toBeNull();
  });

  it("uses hybrid strategy when collection supports it", async () => {
    const qdrant = createMockQdrant();
    qdrant.getCollectionInfo.mockResolvedValue({ hybridEnabled: true });
    qdrant.hybridSearch.mockResolvedValue([{ id: "1", score: 0.85, payload: { content: "x", relativePath: "a.ts" } }]);

    const facade = makeFacade({ qdrant });
    const response = await facade.exploreCode({
      path: "/test/project",
      query: "test",
    });

    expect(qdrant.hybridSearch).toHaveBeenCalled();
    expect(response.results).toHaveLength(1);
  });

  it("passes typed filter params through buildMergedFilter", async () => {
    const registry = createMockRegistry();
    registry.buildFilter.mockReturnValue({
      must: [{ key: "git.file.dominantAuthor", match: { value: "Alice" } }],
    });

    const facade = makeFacade({ registry });
    await facade.exploreCode({
      path: "/test/project",
      query: "auth logic",
      author: "Alice",
    });

    expect(registry.buildFilter).toHaveBeenCalledWith(expect.objectContaining({ author: "Alice" }), "chunk");
  });
});
