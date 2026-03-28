import { describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";

describe("getIndexMetrics", () => {
  function makeExploreFacade() {
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 100 }),
      getPoint: vi.fn().mockResolvedValue(null),
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

    const perLanguage = new Map([
      [
        "typescript",
        new Map([
          [
            "git.file.commitCount",
            {
              source: {
                count: 80,
                min: 1,
                max: 40,
                percentiles: { 25: 3, 50: 6, 75: 14, 95: 28 },
                mean: 7.5,
              },
            },
          ],
        ]),
      ],
    ]);

    const statsCache = {
      load: vi.fn().mockReturnValue({
        perSignal,
        perLanguage,
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

  it("omits global when single code language in perLanguage", async () => {
    // Default mock has only "typescript" in perLanguage → single language → no global
    const { facade } = makeExploreFacade();
    const result = await facade.getIndexMetrics("/project");
    expect(result.signals["global"]).toBeUndefined();
    // Only typescript key present, with source scope
    const signal = result.signals["typescript"]["git.file.commitCount"];
    expect(signal).toBeDefined();
    expect(signal["source"].labelMap.low).toBe(3);
  });

  it("includes global when multiple code languages in perLanguage", async () => {
    const { facade, statsCache } = makeExploreFacade();
    // Override with multi-language perLanguage
    statsCache.load.mockReturnValue({
      perSignal: new Map([
        [
          "git.file.commitCount",
          { count: 100, min: 1, max: 47, percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 }, mean: 8.3 },
        ],
      ]),
      perLanguage: new Map([
        [
          "typescript",
          new Map([
            [
              "git.file.commitCount",
              {
                source: { count: 80, min: 1, max: 40, percentiles: { 25: 3, 50: 6, 75: 14, 95: 28 }, mean: 7.5 },
              },
            ],
          ]),
        ],
        [
          "ruby",
          new Map([
            [
              "git.file.commitCount",
              {
                source: { count: 20, min: 1, max: 10, percentiles: { 25: 1, 50: 3, 75: 5, 95: 8 }, mean: 3.2 },
              },
            ],
          ]),
        ],
      ]),
      distributions: {
        totalFiles: 50,
        language: { typescript: 80, ruby: 20 },
        chunkType: {},
        documentation: { docs: 0, code: 100 },
        topAuthors: [],
        othersCount: 0,
      },
      computedAt: Date.now(),
    });
    const result = await facade.getIndexMetrics("/project");
    expect(result.signals["global"]).toBeDefined();
    expect(result.signals["global"]["git.file.commitCount"]["source"].count).toBe(100);
    expect(result.signals["typescript"]).toBeDefined();
    expect(result.signals["ruby"]).toBeDefined();
  });

  it("returns scoped signal metrics per language", async () => {
    const { facade, statsCache } = makeExploreFacade();
    statsCache.load.mockReturnValue({
      perSignal: new Map([
        [
          "git.file.commitCount",
          { count: 100, min: 1, max: 47, percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 }, mean: 8.3 },
        ],
      ]),
      perLanguage: new Map([
        [
          "ruby",
          new Map([
            [
              "git.file.commitCount",
              {
                source: { count: 80, min: 1, max: 30, percentiles: { 25: 2, 50: 5, 75: 10, 95: 25 }, mean: 7.0 },
                test: { count: 40, min: 1, max: 80, percentiles: { 25: 5, 50: 12, 75: 25, 95: 60 }, mean: 18.0 },
              },
            ],
          ]),
        ],
      ]),
      distributions: {
        totalFiles: 50,
        language: { ruby: 120 },
        chunkType: {},
        documentation: { docs: 0, code: 120 },
        topAuthors: [],
        othersCount: 0,
      },
      computedAt: Date.now(),
    });

    const result = await facade.getIndexMetrics("/project");
    const rubySignals = result.signals["ruby"];
    expect(rubySignals).toBeDefined();

    const ccMetrics = rubySignals["git.file.commitCount"];
    expect(ccMetrics).toBeDefined();
    // Should have source and test scopes
    expect(ccMetrics["source"]).toBeDefined();
    expect(ccMetrics["source"].labelMap.low).toBe(2);
    expect(ccMetrics["source"].mean).toBe(7.0);
    expect(ccMetrics["test"]).toBeDefined();
    expect(ccMetrics["test"].labelMap.low).toBe(5);
    expect(ccMetrics["test"].mean).toBe(18.0);
  });

  it("throws if collection does not exist", async () => {
    const { facade, qdrant } = makeExploreFacade();
    qdrant.collectionExists.mockResolvedValue(false);
    await expect(facade.getIndexMetrics("/project")).rejects.toThrow("not found");
  });

  it("throws if stats not available", async () => {
    const { facade, statsCache } = makeExploreFacade();
    statsCache.load.mockReturnValue(null);
    await expect(facade.getIndexMetrics("/project")).rejects.toThrow("is not indexed");
  });
});
