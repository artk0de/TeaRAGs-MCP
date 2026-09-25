/**
 * `codegraph.file.instability` keeps its structural atoms out of the SAMPLE and
 * on the LADDER (bd tea-rags-mcp-z4lgo).
 *
 * `fanOut / (fanIn + fanOut)` reads exactly 1 for every file with `fanIn` 0 and
 * exactly 0 for every file with `fanOut` 0, at any support: pure source and
 * pure sink are classes, not positions on the scale. Measured on this project's
 * own index, typescript source, 1158 files (427 at 0, 53 at 1): the sample the
 * support floor alone admits has p95 = 1.000 (n306), so `unstable` is a band
 * holding one value. Interior only (0 < I < 1) plus the p75 support floor gives
 * n289 with p75 0.833, p90 0.889, p95 0.909.
 *
 * The atoms leave the sample only. Graded against the interior bands, I == 1
 * lands above p95 and reads `unstable`, I == 0 lands below p50 and reads
 * `stable` — Martin's reading of the two classes.
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
import { computeCollectionStats } from "../../../../../../src/core/domains/ingest/infra/collection-stats.js";
import { CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";
import { staticStatsAccumulators } from "../../../../../../src/core/domains/trajectory/static/stats/index.js";

const INSTABILITY_KEY = "codegraph.file.instability";
const CONNECTION_COUNT_KEY = "codegraph.file.connectionCount";

function descriptor(key: string): PayloadSignalDescriptor {
  const d = CODEGRAPH_SYMBOLS_FILE_SIGNALS.find((s) => s.key === key);
  if (!d) throw new Error(`descriptor not found: ${key}`);
  return d;
}

describe("codegraph.file.instability — structural atoms declaration", () => {
  it("declares the pure-sink and pure-source values as structural atoms", () => {
    expect(descriptor(INSTABILITY_KEY).stats?.structuralAtoms).toEqual([0, 1]);
  });

  it("keeps the support floor alongside the atoms", () => {
    expect(descriptor(INSTABILITY_KEY).stats?.minSupportPercentile).toBe(75);
  });
});

describe("codegraph.file.instability — sampling with the real descriptors", () => {
  /**
   * Twelve well-observed typescript files (connectionCount 20) — eight
   * interior ratios plus two entry points and two leaves — and eight one-edge
   * files the support floor excludes anyway.
   */
  function points(): { payload: Record<string, unknown> }[] {
    const wide: [number, number][] = [
      [0.2, 20],
      [0.3, 20],
      [0.4, 20],
      [0.5, 20],
      [0.6, 20],
      [0.7, 20],
      [0.8, 20],
      [0.85, 20],
      [1, 20],
      [1, 20],
      [0, 20],
      [0, 20],
    ];
    const thin: [number, number][] = Array.from({ length: 8 }, () => [1, 1]);
    return [...wide, ...thin].map(([instability, connectionCount], i) => ({
      payload: {
        language: "typescript",
        chunkType: "function",
        isDocumentation: false,
        relativePath: `src/f${i}.ts`,
        codegraph: { symbols: { file: { instability, connectionCount, fanIn: 1, fanOut: 1 } } },
      },
    }));
  }

  it("takes the top band off the 1.0 atom even for well-observed entry points", () => {
    const stats = computeCollectionStats(points(), CODEGRAPH_SYMBOLS_FILE_SIGNALS, staticStatsAccumulators);
    const instability = stats.perSignal.get(INSTABILITY_KEY)!;

    expect(instability.max).toBeLessThan(1);
    expect(instability.min).toBeGreaterThan(0);
    expect(instability.percentiles[95]).toBeLessThan(1);
  });
});

/** Minimal file-level preset surfacing the raw instability overlay. */
class InstabilityAtomProbePreset implements RerankPreset {
  readonly name = "instabilityAtomProbe";
  readonly description = "Probe preset surfacing the raw instability overlay at file level";
  readonly tools = ["semantic_search"];
  readonly signalLevel = "file" as const;
  readonly weights: ScoringWeights = { similarity: 0.7, instability: 0.3 };
  readonly overlayMask: OverlayMask = { file: [INSTABILITY_KEY, CONNECTION_COUNT_KEY] };
}

describe("codegraph.file.instability — atoms are still graded on the read path", () => {
  const reranker = new Reranker(
    CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
    resolvePresets([new InstabilityAtomProbePreset()], []),
    CODEGRAPH_SYMBOLS_FILE_SIGNALS,
  );

  // Bands as measured on the live index over the interior, support-floored sample.
  const stats: CollectionSignalStats = {
    perSignal: new Map([
      [CONNECTION_COUNT_KEY, { count: 1158, min: 1, max: 60, percentiles: { 10: 1, 25: 2, 50: 3, 75: 5, 95: 20 } }],
    ]),
    perLanguage: new Map([
      [
        "typescript",
        new Map([
          [
            INSTABILITY_KEY,
            {
              source: {
                count: 289,
                min: 0.05,
                max: 0.97,
                percentiles: { 50: 0.6, 75: 0.833, 90: 0.889, 95: 0.909 },
                supportFloor: 5,
              },
            },
          ],
        ]),
      ],
    ]),
    distributions: {
      totalFiles: 1158,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 1158 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };

  const filePoint = (instability: number, fanIn: number, fanOut: number): RerankableResult => ({
    score: 0.8,
    payload: {
      relativePath: "src/a.ts",
      startLine: 1,
      endLine: 50,
      language: "typescript",
      chunkType: "function",
      codegraph: { symbols: { file: { instability, connectionCount: fanIn + fanOut, fanIn, fanOut } } },
    },
  });

  it("labels a pure source (I == 1) unstable", async () => {
    reranker.setCollectionStats(stats);

    const ranked = await reranker.rerank([filePoint(1, 0, 12)], "instabilityAtomProbe", "semantic_search");

    expect(ranked[0].rankingOverlay!.file!.instability).toEqual({ value: 1, label: "unstable" });

    reranker.invalidateStats();
  });

  it("labels a pure sink (I == 0) stable", async () => {
    reranker.setCollectionStats(stats);

    const ranked = await reranker.rerank([filePoint(0, 12, 0)], "instabilityAtomProbe", "semantic_search");

    expect(ranked[0].rankingOverlay!.file!.instability).toEqual({ value: 0, label: "stable" });

    reranker.invalidateStats();
  });
});
