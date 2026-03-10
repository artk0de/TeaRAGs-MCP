import { describe, expect, it, vi } from "vitest";

import { SearchFacade } from "../../../src/core/api/search-facade.js";

const searchCodeSpy = vi.fn().mockResolvedValue([{ path: "a.ts", score: 0.9 }]);

vi.mock("../../../src/core/search/search-module.js", () => {
  return {
    SearchModule: class {
      constructor(
        _qdrant: any,
        _embeddings: any,
        _config: any,
        _reranker: any,
        _collectionName: string,
        _buildFilter?: any,
      ) {}
      searchCode = searchCodeSpy;
    },
  };
});

function makeSearchFacade(
  opts: {
    hasStats?: boolean;
    hasCachedStats?: boolean;
    rerankerHasStats?: boolean;
  } = {},
) {
  const reranker = {
    hasCollectionStats: opts.rerankerHasStats ?? false,
    setCollectionStats: vi.fn(),
  } as any;

  const statsCache = opts.hasStats
    ? {
        load: vi.fn().mockReturnValue(opts.hasCachedStats ? { perSignal: new Map(), computedAt: Date.now() } : null),
      }
    : undefined;

  const facade = new SearchFacade({} as any, {} as any, {} as any, reranker, undefined, statsCache as any);

  return { facade, reranker, statsCache };
}

describe("SearchFacade", () => {
  it("delegates searchCode to SearchModule", async () => {
    const { facade } = makeSearchFacade();
    const results = await facade.searchCode("/project", "test query");
    expect(results).toHaveLength(1);
    expect(searchCodeSpy).toHaveBeenCalledWith("test query", undefined);
  });

  it("loads stats from cache on first search when reranker has no stats", async () => {
    const { facade, reranker, statsCache } = makeSearchFacade({
      hasStats: true,
      hasCachedStats: true,
      rerankerHasStats: false,
    });

    await facade.searchCode("/tmp/test-project", "query");

    expect(statsCache!.load).toHaveBeenCalled();
    expect(reranker.setCollectionStats).toHaveBeenCalled();
  });

  it("skips stats loading when reranker already has stats", async () => {
    const { facade, statsCache } = makeSearchFacade({
      hasStats: true,
      hasCachedStats: true,
      rerankerHasStats: true,
    });

    await facade.searchCode("/tmp/test-project", "query");

    expect(statsCache!.load).not.toHaveBeenCalled();
  });

  it("skips stats loading when no statsCache provided", async () => {
    const { facade, reranker } = makeSearchFacade({
      hasStats: false,
      rerankerHasStats: false,
    });

    await facade.searchCode("/tmp/test-project", "query");
    expect(reranker.setCollectionStats).not.toHaveBeenCalled();
  });

  it("does not set stats when cache returns null", async () => {
    const { facade, reranker, statsCache } = makeSearchFacade({
      hasStats: true,
      hasCachedStats: false,
      rerankerHasStats: false,
    });

    await facade.searchCode("/tmp/test-project", "query");

    expect(statsCache!.load).toHaveBeenCalled();
    expect(reranker.setCollectionStats).not.toHaveBeenCalled();
  });

  it("does not throw when stats loading fails", async () => {
    const { facade, statsCache } = makeSearchFacade({
      hasStats: true,
      hasCachedStats: false,
      rerankerHasStats: false,
    });

    statsCache!.load.mockImplementation(() => {
      throw new Error("cache corrupt");
    });

    const results = await facade.searchCode("/tmp/test-project", "query");
    expect(results).toHaveLength(1);
  });
});
