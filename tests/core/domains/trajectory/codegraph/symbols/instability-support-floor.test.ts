/**
 * `codegraph.file.instability` over the units the corpus actually measured
 * (bd tea-rags-mcp-z33bl).
 *
 * Martin instability is `fanOut / (fanIn + fanOut)`, so a file with a single
 * edge can only read 0 or 1 and the bottom of the `connectionCount`
 * distribution manufactures both tails. Measured on this project's own index,
 * typescript source, comparing the raw ratio's observed variance against the
 * pure-binomial floor `mean_i[p(1-p)/n_i]` — at or below 1 the spread is
 * indistinguishable from sampling noise around one corpus-wide ratio:
 *
 *   n>=1  738 files  ratio 0.79    n>=3  568 files  ratio 1.20
 *   n>=5  306 files  ratio 2.36    n>=9   93 files  ratio 5.51
 *
 * `stats.minSupportPercentile: 75` therefore samples the signal only from
 * files whose `connectionCount` clears that percentile of the support's own
 * distribution in the same bucket, and the sampler persists the resolved number
 * as `SignalStats.supportFloor` so the label path excludes exactly the units
 * the bands were computed without.
 *
 * The gate narrows the GLOBAL `perSignal` bucket too, and filter-preset
 * thresholds resolve from that map — so it moves which points `unstableCore`
 * PRE-filters, not just which labels the overlay shows. Both halves are pinned
 * here.
 */

import { describe, expect, it } from "vitest";

import type { ScoringWeights } from "../../../../../../src/core/contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../../src/core/contracts/types/reranker.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
} from "../../../../../../src/core/contracts/types/trajectory.js";
import { resolvePresets } from "../../../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker, type RerankableResult } from "../../../../../../src/core/domains/explore/reranker.js";
import {
  computeCollectionStats,
  validateSignalDependencies,
} from "../../../../../../src/core/domains/ingest/infra/collection-stats.js";
import { CODEGRAPH_FILTER_PRESETS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/filter-presets/index.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";
import { compileFilterPreset } from "../../../../../../src/core/domains/trajectory/filter-presets/compiler.js";
import { staticStatsAccumulators } from "../../../../../../src/core/domains/trajectory/static/stats/index.js";

const INSTABILITY_KEY = "codegraph.file.instability";
const CONNECTION_COUNT_KEY = "codegraph.file.connectionCount";

function descriptor(key: string): PayloadSignalDescriptor {
  const d = CODEGRAPH_SYMBOLS_FILE_SIGNALS.find((s) => s.key === key);
  if (!d) throw new Error(`descriptor not found: ${key}`);
  return d;
}

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

describe("codegraph.file.instability — support-floor declaration", () => {
  it("samples only from files whose support clears the support's own p75", () => {
    expect(descriptor(INSTABILITY_KEY).stats?.minSupportPercentile).toBe(75);
  });

  it("names the support the sampling gate reads, the same one confidence dampening uses", () => {
    expect(descriptor(INSTABILITY_KEY).stats?.confidence?.support).toBe("connectionCount");
  });

  /**
   * The gate is only checkable against a percentile the support PERSISTS, so
   * `validateSignalDependencies` refuses a floor whose percentile is undeclared.
   * `connectionCount` already publishes p75 as its `busy` label tier, so the
   * declaration needs no new percentile — which is what makes this a one-line
   * change rather than a stats-shape one.
   */
  it("resolves against a percentile connectionCount already publishes", () => {
    expect(Object.keys(descriptor(CONNECTION_COUNT_KEY).stats?.labels ?? {})).toContain("p75");
    expect(() => {
      validateSignalDependencies(
        [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS],
        CODEGRAPH_FILTER_PRESETS,
      );
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/**
 * Twelve typescript files. Eight carry one edge each and read the 1.0 atom by
 * construction (`fanIn` 0); four are well connected and read a moderate ratio.
 * `connectionCount` p75 over [1×8, 10, 12, 14, 16] interpolates to 10.5, so
 * only the 12/14/16 files enter the instability sample.
 */
const THIN_SUPPORT = [1, 1, 1, 1, 1, 1, 1, 1];
const WELL_OBSERVED_SUPPORT = [10, 12, 14, 16];
const WELL_OBSERVED_RATIOS = [0.2, 0.25, 0.3, 0.35];
const EXPECTED_FLOOR = 10.5;

function codegraphFilePoints(tag: string, supports: number[], ratios: number[]) {
  return supports.map((connectionCount, i) => ({
    payload: {
      language: "typescript",
      chunkType: "function",
      isDocumentation: false,
      relativePath: `src/${tag}${i}.ts`,
      codegraph: {
        symbols: {
          file: {
            fanIn: Math.round(connectionCount * (1 - ratios[i])),
            fanOut: Math.round(connectionCount * ratios[i]),
            instability: ratios[i],
            connectionCount,
            transitiveImpact: connectionCount * 2,
          },
        },
      },
    },
  }));
}

function corpus() {
  return [
    ...codegraphFilePoints(
      "thin",
      THIN_SUPPORT,
      THIN_SUPPORT.map(() => 1),
    ),
    ...codegraphFilePoints("wide", WELL_OBSERVED_SUPPORT, WELL_OBSERVED_RATIOS),
  ];
}

/** The same descriptors with the gate stripped — the population before this change. */
const UNGATED_FILE_SIGNALS: PayloadSignalDescriptor[] = CODEGRAPH_SYMBOLS_FILE_SIGNALS.map((s) =>
  s.key === INSTABILITY_KEY ? { ...s, stats: { ...s.stats, minSupportPercentile: undefined } } : s,
);

describe("codegraph.file.instability — support-floor sampling", () => {
  it("admits only the files whose connectionCount clears the floor", () => {
    const stats = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const instability = stats.perSignal.get(INSTABILITY_KEY)!;

    expect(instability.count).toBe(3);
    expect(instability.min).toBe(0.25);
    expect(instability.max).toBe(0.35);
  });

  it("persists the resolved floor, equal to connectionCount's p75 in the same bucket", () => {
    const stats = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const instability = stats.perSignal.get(INSTABILITY_KEY)!;
    const support = stats.perSignal.get(CONNECTION_COUNT_KEY)!;

    expect(instability.supportFloor).toBe(support.percentiles[75]);
    expect(instability.supportFloor).toBe(EXPECTED_FLOOR);
  });

  it("resolves a floor per bucket, so the per-language bands exclude the same units", () => {
    const stats = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const scoped = stats.perLanguage.get("typescript")!;

    expect(scoped.get(INSTABILITY_KEY)!.source.supportFloor).toBe(
      scoped.get(CONNECTION_COUNT_KEY)!.source.percentiles[75],
    );
  });

  /**
   * The regression the change exists for: the thin-support files are the ones
   * holding the 1.0 atom, so excluding them is what moves the bands.
   */
  it("takes the top band off the atom the one-edge files manufacture", () => {
    const gated = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const ungated = computeCollectionStats(corpus(), UNGATED_FILE_SIGNALS, staticStatsAccumulators);

    expect(ungated.perSignal.get(INSTABILITY_KEY)!.percentiles[95]).toBe(1);
    expect(gated.perSignal.get(INSTABILITY_KEY)!.percentiles[95]).toBeLessThan(1);
  });

  it("leaves every codegraph signal that declares no gate byte-identical", () => {
    const gated = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const ungated = computeCollectionStats(corpus(), UNGATED_FILE_SIGNALS, staticStatsAccumulators);

    for (const key of [
      "codegraph.file.fanIn",
      "codegraph.file.fanOut",
      CONNECTION_COUNT_KEY,
      "codegraph.file.transitiveImpact",
    ]) {
      expect(gated.perSignal.get(key)).toEqual(ungated.perSignal.get(key));
      expect(gated.perSignal.get(key)?.supportFloor).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Filter preset — the gate narrows what `unstableCore` PRE-filters
// ---------------------------------------------------------------------------

describe("unstableCore — instability p90 after the support floor", () => {
  const unstableCore = CODEGRAPH_FILTER_PRESETS.find((p) => p.name === "unstableCore")!;

  it("resolves its instability leg from the gated global percentile, not the ungated one", () => {
    const gated = computeCollectionStats(corpus(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const ungated = computeCollectionStats(corpus(), UNGATED_FILE_SIGNALS, staticStatsAccumulators);

    const legOf = (stats: CollectionSignalStats) =>
      compileFilterPreset(unstableCore, stats, "file").must!.find(
        (c) => "key" in c && c.key === "codegraph.symbols.file.instability",
      );

    expect(legOf(ungated)).toEqual({
      key: "codegraph.symbols.file.instability",
      range: { gte: ungated.perSignal.get(INSTABILITY_KEY)!.percentiles[90] },
    });
    expect(legOf(gated)).toEqual({
      key: "codegraph.symbols.file.instability",
      range: { gte: gated.perSignal.get(INSTABILITY_KEY)!.percentiles[90] },
    });
    expect(legOf(gated)).not.toEqual(legOf(ungated));
  });
});

// ---------------------------------------------------------------------------
// Read side — a file below the floor keeps a bare number
// ---------------------------------------------------------------------------

/** Minimal file-level preset surfacing the raw instability overlay. */
class InstabilityOverlayProbePreset implements RerankPreset {
  readonly name = "instabilityOverlayProbe";
  readonly description = "Probe preset surfacing the raw instability overlay at file level";
  readonly tools = ["semantic_search"];
  readonly signalLevel = "file" as const;
  readonly weights: ScoringWeights = { similarity: 0.7, instability: 0.3 };
  readonly overlayMask: OverlayMask = { file: [INSTABILITY_KEY, CONNECTION_COUNT_KEY] };
}

describe("codegraph.file.instability — overlay below the support floor", () => {
  const reranker = new Reranker(
    CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    resolvePresets([new InstabilityOverlayProbePreset()], []),
    CODEGRAPH_SYMBOLS_FILE_SIGNALS,
  );

  const statsWithFloor = (floor: number | undefined): CollectionSignalStats => ({
    perSignal: new Map([
      [CONNECTION_COUNT_KEY, { count: 12, min: 1, max: 16, percentiles: { 10: 1, 25: 2, 50: 3, 75: 10.5, 95: 16 } }],
    ]),
    perLanguage: new Map([
      [
        "typescript",
        new Map([
          [
            INSTABILITY_KEY,
            {
              source: {
                count: 3,
                min: 0.25,
                max: 0.35,
                // Bands over the qualified files only.
                percentiles: { 50: 0.3, 75: 0.325, 95: 0.345 },
                ...(floor === undefined ? {} : { supportFloor: floor }),
              },
            },
          ],
        ]),
      ],
    ]),
    distributions: {
      totalFiles: 12,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 12 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  });

  const filePoint = (connectionCount: number, instability: number): RerankableResult => ({
    score: 0.8,
    payload: {
      relativePath: "src/a.ts",
      startLine: 1,
      endLine: 50,
      language: "typescript",
      chunkType: "function",
      codegraph: { symbols: { file: { instability, connectionCount, fanIn: 0, fanOut: connectionCount } } },
    },
  });

  /**
   * Support 3 is deliberately ABOVE the confidence clamp's p25 rule and below
   * the sampling floor, so what the assertion sees is the support gate and not
   * the label ceiling the clamp would apply at p10/p25.
   */
  const BELOW_FLOOR_SUPPORT = 3;

  it("shows a bare number for a file the sampler excluded", async () => {
    reranker.setCollectionStats(statsWithFloor(EXPECTED_FLOOR));

    const ranked = await reranker.rerank(
      [filePoint(BELOW_FLOOR_SUPPORT, 1)],
      "instabilityOverlayProbe",
      "semantic_search",
    );

    expect(ranked[0].rankingOverlay!.file!.instability).toBe(1);

    reranker.invalidateStats();
  });

  it("labels a file whose support clears the floor from the gated bands", async () => {
    reranker.setCollectionStats(statsWithFloor(EXPECTED_FLOOR));

    const ranked = await reranker.rerank([filePoint(12, 0.35)], "instabilityOverlayProbe", "semantic_search");

    expect(ranked[0].rankingOverlay!.file!.instability).toEqual({ value: 0.35, label: "unstable" });

    reranker.invalidateStats();
  });

  /**
   * A stats file written before the declaration carries no floor, and its bands
   * cover everything — so grading everything against them stays the consistent
   * reading until the `statsContract` drift axis repairs the file.
   */
  it("labels normally when the stats file carries no resolved floor", async () => {
    reranker.setCollectionStats(statsWithFloor(undefined));

    const ranked = await reranker.rerank(
      [filePoint(BELOW_FLOOR_SUPPORT, 1)],
      "instabilityOverlayProbe",
      "semantic_search",
    );

    expect(ranked[0].rankingOverlay!.file!.instability).toEqual({ value: 1, label: "unstable" });

    reranker.invalidateStats();
  });
});
