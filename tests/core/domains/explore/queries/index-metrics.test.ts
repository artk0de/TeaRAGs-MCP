/**
 * IndexMetricsQuery — extracted aggregation logic from
 * ExploreFacade.getIndexMetrics. Keeps existing facade-level tests
 * green via behavior preservation; this suite pins the direct
 * contract of the new class.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexMetricsQuery } from "../../../../../src/core/domains/explore/queries/index-metrics.js";

describe("IndexMetricsQuery", () => {
  const makeDeps = (overrides: Partial<Record<string, unknown>> = {}) => {
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 100 }),
      getPoint: vi.fn().mockResolvedValue(null),
      ...(overrides.qdrant ?? {}),
    } as any;

    const statsCache = {
      load: vi.fn().mockReturnValue({
        perSignal: new Map(),
        perLanguage: new Map([
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
        ]),
        distributions: {
          totalFiles: 50,
          language: { typescript: 80 },
          chunkType: {},
          documentation: { docs: 0, code: 80 },
          topAuthors: [],
          othersCount: 0,
        },
        computedAt: Date.now(),
      }),
      ...(overrides.statsCache ?? {}),
    } as any;

    const payloadSignals = [
      {
        key: "git.file.commitCount",
        type: "number",
        description: "Commit count",
        stats: {
          labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
        },
      },
    ] as any;

    return { qdrant, statsCache, payloadSignals };
  };

  it("throws when collection does not exist", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    qdrant.collectionExists.mockResolvedValue(false);
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    await expect(query.run("missing_col", "/project")).rejects.toThrow(/not found/);
  });

  it("throws NotIndexedError when statsCache returns null", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    statsCache.load.mockReturnValue(null);
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    await expect(query.run("col", "/project")).rejects.toThrow(/is not indexed/);
  });

  it("returns shape with collection, totalChunks, totalFiles, distributions, signals", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.collection).toBe("col");
    expect(result.totalChunks).toBe(100);
    expect(result.totalFiles).toBe(50);
    expect(result.distributions.language).toEqual({ typescript: 80 });
    expect(result.signals["typescript"]["git.file.commitCount"]["source"].labelMap.low).toBe(3);
  });

  it("omits global metrics key when only a single code language is present", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.signals["global"]).toBeUndefined();
  });

  it("includes global metrics key when multiple code languages present", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
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
              { source: { count: 80, min: 1, max: 40, percentiles: { 25: 3, 50: 6, 75: 14, 95: 28 }, mean: 7.5 } },
            ],
          ]),
        ],
        [
          "ruby",
          new Map([
            [
              "git.file.commitCount",
              { source: { count: 20, min: 1, max: 10, percentiles: { 25: 1, 50: 3, 75: 5, 95: 8 }, mean: 3.2 } },
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
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.signals["global"]).toBeDefined();
    expect(result.signals["global"]["git.file.commitCount"]["source"].count).toBe(100);
  });

  it("returns both source and test scoped metrics when test stats present", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    statsCache.load.mockReturnValue({
      perSignal: new Map(),
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
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");
    const rubyCC = result.signals["ruby"]["git.file.commitCount"];

    expect(rubyCC["source"].mean).toBe(7.0);
    expect(rubyCC["test"].mean).toBe(18.0);
    expect(rubyCC["test"].labelMap.low).toBe(5);
  });

  it("includes enrichment health from marker payload when present", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    qdrant.getPoint.mockResolvedValue({
      payload: {
        enrichment: {
          git: {
            file: { status: "complete", startedAt: 1, completedAt: 2, durationMs: 1 },
            chunk: { status: "complete", startedAt: 3, completedAt: 4, durationMs: 1 },
          },
        },
      },
    });
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.enrichment).toBeDefined();
  });

  it("leaves enrichment undefined when no marker payload exists", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.enrichment).toBeUndefined();
  });
});
