import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";

describe("getIndexMetrics", () => {
  function makeExploreFacade() {
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 100 }),
    } as any;

    const embeddings = {
      embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
      getDimensions: vi.fn().mockReturnValue(3),
    } as any;

    const reranker = {
      hasCollectionStats: false,
      setCollectionStats: vi.fn(),
      getDescriptors: vi.fn().mockReturnValue([]),
      getPreset: vi.fn().mockReturnValue(null),
      rerank: vi.fn((results: any[]) => results),
    } as any;

    const registry = {
      buildFilter: vi.fn().mockReturnValue(undefined),
      buildMergedFilter: vi.fn().mockReturnValue(undefined),
      getAllFilters: vi.fn().mockReturnValue([]),
      getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
      getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    } as any;

    const distributions = {
      totalFiles: 50,
      language: { typescript: 80 },
      chunkType: { function: 60 },
      documentation: { docs: 10, code: 90 },
      topAuthors: [{ name: "Alice", chunks: 70 }],
      othersCount: 30,
    };

    const perSignal = new Map([
      [
        "git.file.commitCount",
        {
          count: 100,
          min: 1,
          max: 47,
          percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 },
          mean: 8.3,
        },
      ],
    ]);

    const statsCache = {
      load: vi.fn().mockReturnValue({
        perSignal,
        distributions,
        computedAt: Date.now(),
      }),
    } as any;

    const payloadSignals = [
      {
        key: "git.file.commitCount",
        type: "number",
        description: "Commit count",
        stats: {
          labels: {
            p25: "low",
            p50: "typical",
            p75: "high",
            p95: "extreme",
          },
        },
      },
    ] as any;

    const facade = new ExploreFacade({
      qdrant,
      embeddings,
      reranker,
      registry,
      statsCache,
      payloadSignals,
    });

    return { facade, qdrant, statsCache };
  }

  it("returns collection name and totalChunks from collectionInfo", async () => {
    const { facade } = makeExploreFacade();
    const result = await facade.getIndexMetrics("/project");
    expect(result.collection).toContain("code_");
    expect(result.totalChunks).toBe(100);
  });

  it("returns distributions from stats cache", async () => {
    const { facade } = makeExploreFacade();
    const result = await facade.getIndexMetrics("/project");
    expect(result.totalFiles).toBe(50);
    expect(result.distributions.language).toEqual({ typescript: 80 });
    expect(result.distributions.topAuthors[0].name).toBe("Alice");
  });

  it("returns signals with labelMap built from percentile labels", async () => {
    const { facade } = makeExploreFacade();
    const result = await facade.getIndexMetrics("/project");
    const signal = result.signals["git.file.commitCount"];
    expect(signal).toBeDefined();
    expect(signal.min).toBe(1);
    expect(signal.max).toBe(47);
    expect(signal.mean).toBe(8.3);
    expect(signal.count).toBe(100);
    expect(signal.labelMap.low).toBe(2);
    expect(signal.labelMap.typical).toBe(5);
    expect(signal.labelMap.high).toBe(12);
    expect(signal.labelMap.extreme).toBe(30);
  });

  it("throws if collection does not exist", async () => {
    const { facade, qdrant } = makeExploreFacade();
    qdrant.collectionExists.mockResolvedValue(false);
    await expect(facade.getIndexMetrics("/project")).rejects.toThrow("Collection not found");
  });

  it("throws if stats not available", async () => {
    const { facade, statsCache } = makeExploreFacade();
    statsCache.load.mockReturnValue(null);
    await expect(facade.getIndexMetrics("/project")).rejects.toThrow("No statistics available");
  });
});
