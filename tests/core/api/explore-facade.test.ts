import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";

function makeExploreFacade(
  opts: {
    hasStats?: boolean;
    hasCachedStats?: boolean;
    rerankerHasStats?: boolean;
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
    setCollectionStats: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getPreset: vi.fn().mockReturnValue(null),
    rerank: vi.fn((results: any[]) => results),
  } as any;

  const statsCache = opts.hasStats
    ? {
        load: vi.fn().mockReturnValue(opts.hasCachedStats ? { perSignal: new Map(), computedAt: Date.now() } : null),
      }
    : undefined;

  const registry = {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;

  const facade = new ExploreFacade({ qdrant, embeddings, reranker, registry, statsCache: statsCache as any });

  return { facade, qdrant, reranker, statsCache };
}

describe("ExploreFacade", () => {
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
});
