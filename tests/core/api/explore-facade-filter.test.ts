import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";
import { filterMetaOnly } from "../../../src/core/domains/explore/post-process.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit || 5,
    fetchLimit: (limit || 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) => results),
}));

vi.mock("../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  BM25SparseVectorGenerator: {
    generateSimple: vi.fn(() => ({ indices: [1, 2], values: [0.5, 0.5] })),
  },
}));

vi.mock("../../../src/core/domains/explore/rank-module.js", () => ({
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
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
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
      undefined, // no level override → chunk default
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

  // bd tea-rags-mcp-d9w4o: a ticket drill reads the matched ids off the meta-only row.
  it("keeps the requested level's taskIds on a metaOnly taskId search row", async () => {
    const qdrant = makeMockQdrant();
    qdrant.search.mockResolvedValue([
      {
        id: "p1",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          symbolId: "A#run",
          startLine: 1,
          endLine: 9,
          content: "run() {}",
          git: { file: { taskIds: ["T-1", "T-2"] }, chunk: { taskIds: ["T-1"], commitCount: 2 } },
        },
      },
    ]);
    // As production declares them: both taskIds levels are essential git keys.
    const registry = makeMockRegistry();
    registry.getEssentialPayloadKeys.mockReturnValue(["git.file.taskIds", "git.chunk.taskIds"]);
    const { facade } = makeFacade({ qdrant, registry });
    // The real metaOnly step keeps essential git keys; this file mocks it, so stand it in per call.
    const asMetaOnly = (results: any[]) => results.map((r) => r.payload);
    vi.mocked(filterMetaOnly)
      .mockImplementationOnce(asMetaOnly)
      .mockImplementationOnce(asMetaOnly)
      .mockImplementationOnce(asMetaOnly);

    const chunkLevel = await facade.semanticSearch({
      collection: "test",
      query: "q",
      taskId: "T-1",
      level: "chunk",
      metaOnly: true,
    });
    const fileDefault = await facade.semanticSearch({ collection: "test", query: "q", taskId: "T-1", metaOnly: true });
    const noTicket = await facade.semanticSearch({ collection: "test", query: "q", metaOnly: true });

    expect(chunkLevel.results[0]?.payload?.git).toEqual({ chunk: { taskIds: ["T-1"] } });
    expect(fileDefault.results[0]?.payload?.git).toEqual({ file: { taskIds: ["T-1", "T-2"] } });
    expect(noTicket.results[0]?.payload?.git).toBeUndefined();
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
      undefined, // no level override → chunk default
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

  it("passes resolved level to registry.buildMergedFilter for searchCode", async () => {
    const registry = makeMockRegistry();
    registry.buildMergedFilter.mockReturnValue(undefined);
    const qdrant = makeMockQdrant();
    const { facade } = makeFacade({ qdrant, registry });

    await facade.searchCode({
      path: "/tmp/test-project",
      query: "test query",
      language: "typescript",
    });

    // searchCode passes level as 3rd argument (undefined when no preset signalLevel)
    const call = registry.buildMergedFilter.mock.calls[0];
    expect(call).toHaveLength(3);
    expect(call[0]).toEqual(expect.objectContaining({ language: "typescript" }));
    expect(call[2]).toBeUndefined(); // no preset → no level override
  });
});
