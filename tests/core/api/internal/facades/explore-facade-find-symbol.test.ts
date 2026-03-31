import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

vi.mock("../../../../../src/core/domains/explore/rank-module.js", () => ({
  RankModule: class {
    constructor(_reranker: any, _descriptors: any) {}
    rankChunks = vi.fn().mockResolvedValue([]);
  },
}));

describe("ExploreFacade.findSymbol", () => {
  let facade: ExploreFacade;
  const mockScrollFiltered = vi.fn();
  const mockCollectionExists = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    mockScrollFiltered.mockResolvedValue([
      {
        id: "uuid-1",
        payload: {
          symbolId: "Reranker.score",
          chunkType: "function",
          relativePath: "src/reranker.ts",
          content: "score() { return 42; }",
          startLine: 30,
          endLine: 50,
          language: "typescript",
          git: { file: { commitCount: 5 } },
        },
      },
    ]);

    facade = new ExploreFacade({
      qdrant: {
        scrollFiltered: mockScrollFiltered,
        collectionExists: mockCollectionExists,
      } as any,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [] }) } as any,
      reranker: {
        rerank: vi.fn((r: any[]) => r),
        hasCollectionStats: false,
        setCollectionStats: vi.fn(),
        getDescriptors: vi.fn().mockReturnValue([]),
        getPreset: vi.fn(),
        getPresetNames: vi.fn().mockReturnValue([]),
        getFullPreset: vi.fn().mockReturnValue(undefined),
      } as any,
      registry: {
        buildMergedFilter: vi.fn().mockReturnValue(undefined),
        getAllFilters: vi.fn().mockReturnValue([]),
        getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
        getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      } as any,
    });
  });

  it("returns resolved symbols from scroll results", async () => {
    const result = await facade.findSymbol({
      symbol: "Reranker.score",
      collection: "test_collection",
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].payload?.symbolId).toBe("Reranker.score");
    expect(result.results[0].score).toBe(1.0);
  });

  it("builds symbolId text match filter", async () => {
    await facade.findSymbol({
      symbol: "Reranker",
      collection: "test_collection",
    });

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        must: expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }]),
      }),
      expect.any(Number),
    );
  });

  it("includes language filter when provided", async () => {
    await facade.findSymbol({
      symbol: "validate",
      collection: "test_collection",
      language: "typescript",
    });

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        must: expect.arrayContaining([
          { key: "symbolId", match: { text: "validate" } },
          { key: "language", match: { value: "typescript" } },
        ]),
      }),
      expect.any(Number),
    );
  });

  it("applies negation pathPattern as must_not filter", async () => {
    const deps = {
      qdrant: {
        scrollFiltered: mockScrollFiltered,
        collectionExists: mockCollectionExists,
      } as any,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [] }) } as any,
      reranker: {
        rerank: vi.fn((r: any[]) => r),
        hasCollectionStats: false,
        setCollectionStats: vi.fn(),
        getDescriptors: vi.fn().mockReturnValue([]),
        getPreset: vi.fn(),
        getPresetNames: vi.fn().mockReturnValue([]),
        getFullPreset: vi.fn().mockReturnValue(undefined),
      } as any,
      registry: {
        buildMergedFilter: vi.fn().mockReturnValue({
          must_not: [{ key: "relativePath", match: { text: "ingest/" } }],
        }),
        getAllFilters: vi.fn().mockReturnValue([]),
        getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
        getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      } as any,
    };
    const facadeWithFilter = new ExploreFacade(deps);

    await facadeWithFilter.findSymbol({
      symbol: "Pipeline",
      collection: "test_collection",
      pathPattern: "!**/ingest/**",
    });

    expect(mockScrollFiltered).toHaveBeenCalledWith(
      "test_collection",
      expect.objectContaining({
        must_not: [{ key: "relativePath", match: { text: "ingest/" } }],
      }),
      expect.any(Number),
    );
  });

  it("applies pathPattern filter to both symbol and member scrolls", async () => {
    const pathMust = [{ key: "relativePath", match: { text: "tests/" } }];
    const deps = {
      qdrant: {
        scrollFiltered: mockScrollFiltered,
        collectionExists: mockCollectionExists,
      } as any,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [] }) } as any,
      reranker: {
        rerank: vi.fn((r: any[]) => r),
        hasCollectionStats: false,
        setCollectionStats: vi.fn(),
        getDescriptors: vi.fn().mockReturnValue([]),
        getPreset: vi.fn(),
        getPresetNames: vi.fn().mockReturnValue([]),
        getFullPreset: vi.fn().mockReturnValue(undefined),
      } as any,
      registry: {
        buildMergedFilter: vi.fn().mockReturnValue({ must: pathMust }),
        getAllFilters: vi.fn().mockReturnValue([]),
        getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
        getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      } as any,
    };
    const facadeWithFilter = new ExploreFacade(deps);

    await facadeWithFilter.findSymbol({
      symbol: "Reranker",
      collection: "test_collection",
      pathPattern: "**/tests/**",
    });

    // Both scroll calls should include pathPattern conditions
    expect(mockScrollFiltered).toHaveBeenCalledTimes(2);

    // First call: symbolId filter + pathPattern
    const symbolFilter = mockScrollFiltered.mock.calls[0][1];
    expect(symbolFilter.must).toEqual(
      expect.arrayContaining([{ key: "symbolId", match: { text: "Reranker" } }, ...pathMust]),
    );

    // Second call: parentName filter + pathPattern
    const parentFilter = mockScrollFiltered.mock.calls[1][1];
    expect(parentFilter.must).toEqual(
      expect.arrayContaining([{ key: "parentName", match: { text: "Reranker" } }, ...pathMust]),
    );
  });

  it("returns empty results when no symbols match", async () => {
    mockScrollFiltered.mockResolvedValue([]);

    const result = await facade.findSymbol({
      symbol: "nonexistent",
      collection: "test_collection",
    });

    expect(result.results).toEqual([]);
  });

  it("throws CollectionNotFoundError when collection does not exist", async () => {
    const facadeWithMissing = new ExploreFacade({
      qdrant: {
        scrollFiltered: mockScrollFiltered,
        collectionExists: vi.fn().mockResolvedValue(false),
      } as any,
      embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [] }) } as any,
      reranker: {
        rerank: vi.fn((r: any[]) => r),
        hasCollectionStats: false,
        setCollectionStats: vi.fn(),
        getDescriptors: vi.fn().mockReturnValue([]),
        getPreset: vi.fn(),
        getPresetNames: vi.fn().mockReturnValue([]),
        getFullPreset: vi.fn().mockReturnValue(undefined),
      } as any,
      registry: {
        buildMergedFilter: vi.fn().mockReturnValue(undefined),
        getAllFilters: vi.fn().mockReturnValue([]),
        getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
        getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      } as any,
    });

    await expect(facadeWithMissing.findSymbol({ symbol: "Anything", collection: "missing_col" })).rejects.toThrow(
      /not found/,
    );
  });
});
