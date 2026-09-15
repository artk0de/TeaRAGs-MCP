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
      countPoints: vi.fn().mockResolvedValue(100),
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

  // bd tea-rags-mcp-x2u65 — get_index_metrics carries the same health frame as
  // get_index_status: the running composition's providers, not the ones the
  // last run happened to touch. `--force-enrichments codegraph` leaves a run
  // marker naming `codegraph.symbols` alone while git markers from an earlier
  // run stay valid on the same points.
  describe("enrichment health frame (active providers)", () => {
    const NOW = new Date().toISOString();
    const forcedCodegraphRun = {
      _run: { runId: "run-2", startedAt: NOW, lastProgressAt: NOW, providers: ["codegraph.symbols"] },
      git: {
        file: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
        chunk: { runId: "run-1", status: "completed", unenrichedChunks: 0 },
      },
      codegraph: {
        symbols: {
          file: { runId: "run-2", status: "completed", unenrichedChunks: 0 },
          chunk: { runId: "run-2", status: "completed", unenrichedChunks: 0 },
        },
      },
    };

    it("renders every active provider, git from its own older terminal marker", async () => {
      const { qdrant, statsCache, payloadSignals } = makeDeps();
      qdrant.getPoint.mockResolvedValue({ payload: { enrichment: forcedCodegraphRun } });
      const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

      const result = await query.run("col", "/project", ["git", "codegraph.symbols"]);

      expect(Object.keys(result.enrichment!).sort()).toEqual(["codegraph.symbols", "git"]);
      expect(result.enrichment!.git.file.status).toBe("healthy");
      expect(result.enrichment!.git.chunk.status).toBe("healthy");
      expect(result.enrichment!["codegraph.symbols"].file.status).toBe("healthy");
    });

    // The frame comes from the passed list and from nothing else: unwired,
    // a run-pointer marker has nothing to report against. Pins that the
    // frame argument is load-bearing rather than decorative.
    it("reports nothing for a run-pointer marker when no active providers are wired", async () => {
      const { qdrant, statsCache, payloadSignals } = makeDeps();
      qdrant.getPoint.mockResolvedValue({ payload: { enrichment: forcedCodegraphRun } });
      const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

      const result = await query.run("col", "/project");

      expect(result.enrichment).toBeUndefined();
    });
  });

  // btl8: codegraph signals with stats.labels must surface in labelMap just
  // like git signals. Before this commit, the 7 codegraph numeric descriptors
  // lacked stats.labels so IndexMetricsQuery skipped them (line 57 early
  // continue), making fanIn/fanOut/instability/etc invisible to get_index_metrics.
  it("renders labelMap for codegraph signals with stats.labels", async () => {
    const { qdrant } = makeDeps();
    const statsCache = {
      load: vi.fn().mockReturnValue({
        perSignal: new Map(),
        perLanguage: new Map([
          [
            "typescript",
            new Map([
              [
                "codegraph.file.fanIn",
                {
                  source: { count: 100, min: 0, max: 50, percentiles: { 25: 1, 50: 3, 75: 7, 95: 18 }, mean: 4.5 },
                },
              ],
            ]),
          ],
        ]),
        distributions: {
          totalFiles: 50,
          language: { typescript: 100 },
          chunkType: {},
          documentation: { docs: 0, code: 100 },
          topAuthors: [],
          othersCount: 0,
        },
        computedAt: Date.now(),
      }),
    } as any;
    const payloadSignals = [
      {
        key: "codegraph.file.fanIn",
        type: "number",
        description: "Number of files importing this file",
        stats: { labels: { p25: "isolated", p50: "typical", p75: "popular", p95: "hub" } },
      },
    ] as any;
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.signals["typescript"]["codegraph.file.fanIn"]["source"].labelMap).toEqual({
      isolated: 1,
      typical: 3,
      popular: 7,
      hub: 18,
    });
  });

  // Display-hint passthrough: a descriptor declaring stats.format surfaces it on
  // the SignalMetrics DTO so prime can render normalized [0,1] signals (e.g.
  // codegraph.chunk.pageRank, whose meaningful percentiles live at 1e-4..1e-1
  // and round to "≤0" on the raw scale) as percentages. labelMap value stays raw.
  it("surfaces stats.format as a display hint on SignalMetrics, leaving labelMap raw", async () => {
    const { qdrant } = makeDeps();
    const statsCache = {
      load: vi.fn().mockReturnValue({
        perSignal: new Map(),
        perLanguage: new Map([
          [
            "typescript",
            new Map([
              [
                "codegraph.chunk.pageRank",
                {
                  source: {
                    count: 100,
                    min: 0,
                    max: 0.1,
                    percentiles: { 50: 0.00028, 75: 0.00041, 95: 0.0012 },
                    mean: 0.0005,
                  },
                },
              ],
            ]),
          ],
        ]),
        distributions: {
          totalFiles: 50,
          language: { typescript: 100 },
          chunkType: {},
          documentation: { docs: 0, code: 100 },
          topAuthors: [],
          othersCount: 0,
        },
        computedAt: Date.now(),
      }),
    } as any;
    const payloadSignals = [
      {
        key: "codegraph.chunk.pageRank",
        type: "number",
        description: "PageRank over the method call graph",
        stats: {
          labels: { p50: "peripheral", p75: "important", p95: "critical" },
          format: "percent",
        },
      },
    ] as any;
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    const metrics = result.signals["typescript"]["codegraph.chunk.pageRank"]["source"];
    expect(metrics.format).toBe("percent");
    // labelMap stays raw — format is a render-time hint, not a value transform.
    expect(metrics.labelMap).toEqual({ peripheral: 0.00028, important: 0.00041, critical: 0.0012 });
  });
});
