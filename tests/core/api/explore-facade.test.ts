import { describe, expect, it, vi } from "vitest";

import { CollectionNotFoundError, ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";
import { LOCATOR_SIGNALS } from "../domains/explore/__fixtures__/locator-signals.js";

function makeExploreFacade(
  opts: {
    hasStats?: boolean;
    hasCachedStats?: boolean;
    rerankerHasStats?: boolean;
    payloadSignals?: typeof LOCATOR_SIGNALS;
  } = {},
) {
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([
      {
        id: "1",
        score: 0.9,
        payload: {
          content: "fn test()",
          relativePath: "a.ts",
          startLine: 1,
          endLine: 5,
          language: "typescript",
          fileExtension: ".ts",
        },
      },
    ]),
  } as any;

  const embeddings = {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;

  const reranker = {
    hasCollectionStats: opts.rerankerHasStats ?? false,
    hasCollectionStatsFor: vi.fn().mockReturnValue(opts.rerankerHasStats ?? false),
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    setRecomputeService: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getPreset: vi.fn().mockReturnValue(null),
    rerank: vi.fn((results: any[]) => results),
  } as any;

  const statsCache = opts.hasStats
    ? {
        load: vi.fn().mockReturnValue(opts.hasCachedStats ? { perSignal: new Map(), computedAt: Date.now() } : null),
        lastWrittenAt: vi.fn().mockReturnValue(opts.hasCachedStats ? 1 : undefined),
      }
    : undefined;

  const registry = {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;

  const facade = new ExploreFacade({
    qdrant,
    embeddings,
    reranker,
    registry,
    statsCache: statsCache as any,
    payloadSignals: opts.payloadSignals,
  });

  return { facade, qdrant, reranker, statsCache };
}

describe("ExploreFacade", () => {
  it.each(["semanticSearch", "hybridSearch"] as const)(
    "%s carries distinctFiles to retrieval and returns method locators",
    async (method) => {
      const { facade, qdrant } = makeExploreFacade({ payloadSignals: LOCATOR_SIGNALS });
      const hits = [
        { id: "a1", score: 0.9, payload: { relativePath: "src/a.ts", symbolId: "A#first", startLine: 1, endLine: 3 } },
        { id: "a2", score: 0.8, payload: { relativePath: "src/a.ts", symbolId: "A#second", startLine: 5, endLine: 8 } },
        { id: "b", score: 0.7, payload: { relativePath: "src/b.ts", symbolId: "B#run", startLine: 2, endLine: 4 } },
      ];
      qdrant.search.mockResolvedValue(hits);
      qdrant.queryGroups = vi.fn().mockResolvedValue([hits[0], hits[2]]);
      qdrant.hybridSearch = vi.fn().mockResolvedValue(hits);
      qdrant.getCollectionInfo = vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 3 });
      const result = await facade[method]({
        collection: "test_col",
        query: "matching behavior",
        distinctFiles: true,
        limit: 2,
        metaOnly: true,
      });
      expect(
        result.results.map((row) => [row.payload?.relativePath, row.payload?.symbolId, row.payload?.startLine]),
      ).toEqual([
        ["src/a.ts", "A#first", 1],
        ["src/b.ts", "B#run", 2],
      ]);
    },
  );

  it("delegates searchCode to vector strategy", async () => {
    const { facade, qdrant } = makeExploreFacade();
    const result = await facade.searchCode({ path: "/project", query: "test query" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].score).toBe(0.9);
    expect(qdrant.search).toHaveBeenCalled();
  });

  it("loads stats from cache on first search when reranker has no stats", async () => {
    const { facade, reranker, statsCache } = makeExploreFacade({
      hasStats: true,
      hasCachedStats: true,
      rerankerHasStats: false,
    });

    await facade.searchCode({ path: "/tmp/test-project", query: "query" });

    expect(statsCache!.load).toHaveBeenCalled();
    expect(reranker.setCollectionStats).toHaveBeenCalled();
  });

  it("skips stats loading when reranker already has stats", async () => {
    const { facade, statsCache } = makeExploreFacade({
      hasStats: true,
      hasCachedStats: true,
      rerankerHasStats: true,
    });

    await facade.searchCode({ path: "/tmp/test-project", query: "query" });

    expect(statsCache!.load).not.toHaveBeenCalled();
  });

  it("skips stats loading when no statsCache provided", async () => {
    const { facade, reranker } = makeExploreFacade({
      hasStats: false,
      rerankerHasStats: false,
    });

    await facade.searchCode({ path: "/tmp/test-project", query: "query" });
    expect(reranker.setCollectionStats).not.toHaveBeenCalled();
  });

  it("does not set stats when cache returns null", async () => {
    const { facade, reranker, statsCache } = makeExploreFacade({
      hasStats: true,
      hasCachedStats: false,
      rerankerHasStats: false,
    });

    await facade.searchCode({ path: "/tmp/test-project", query: "query" });

    expect(statsCache!.load).toHaveBeenCalled();
    expect(reranker.setCollectionStats).not.toHaveBeenCalled();
  });

  it("does not throw when stats loading fails", async () => {
    const { facade, statsCache } = makeExploreFacade({
      hasStats: true,
      hasCachedStats: false,
      rerankerHasStats: false,
    });

    statsCache!.load.mockImplementation(() => {
      throw new Error("cache corrupt");
    });

    const result = await facade.searchCode({ path: "/tmp/test-project", query: "query" });
    expect(result.results).toHaveLength(1);
  });

  // Live round-3 D3: search_code answered a missing index with Qdrant's raw
  // "Not Found" (UNKNOWN_ERROR) while every other read tool answers the typed
  // not-found error — checked before the query is embedded.
  it("refuses a missing index with the typed not-found error, before embedding the query", async () => {
    const { facade, qdrant } = makeExploreFacade();
    qdrant.collectionExists.mockResolvedValue(false);

    await expect(facade.searchCode({ path: "/tmp/test-project", query: "query" })).rejects.toBeInstanceOf(
      CollectionNotFoundError,
    );
    expect(qdrant.search).not.toHaveBeenCalled();
  });
});
