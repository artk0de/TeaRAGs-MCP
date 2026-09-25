/**
 * `git.file.recentDominantAuthorPct` labels a one-contributor file `solo` and
 * cuts its percentile ladder over the files with two or more recent
 * contributors only (bd tea-rags-mcp-od098, Route B).
 *
 * A file whose recent history has one author reads 100% dominance by
 * construction, so that value is class membership, not a position on the
 * scale. Measured on this project's own index, 72% of files sat on it and the
 * published ladder read p25 = p50 = p75 = p95 = 100: every threshold at the
 * maximum, one reachable name. `blameDominantAuthorPct` is the same shape and
 * deliberately stays as it is.
 */

import { describe, expect, it } from "vitest";

import type { ScoringWeights } from "../../../../../src/core/contracts/types/provider.js";
import type { OverlayMask, RerankPreset } from "../../../../../src/core/contracts/types/reranker.js";
import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import { resolvePresets } from "../../../../../src/core/domains/explore/rerank/presets/index.js";
import { Reranker, type RerankableResult } from "../../../../../src/core/domains/explore/reranker.js";
import { computeCollectionStats } from "../../../../../src/core/domains/ingest/infra/collection-stats.js";
import { gitPayloadSignalDescriptors } from "../../../../../src/core/domains/trajectory/git/payload-signals.js";
import { gitDerivedSignals } from "../../../../../src/core/domains/trajectory/git/rerank/derived-signals/index.js";
import { gitStatsAccumulators } from "../../../../../src/core/domains/trajectory/git/stats/index.js";

const PCT_KEY = "git.file.recentDominantAuthorPct";

function descriptor(key: string) {
  const d = gitPayloadSignalDescriptors.find((s) => s.key === key);
  if (!d) throw new Error(`descriptor not found: ${key}`);
  return d;
}

describe("git.file.recentDominantAuthorPct — solo class declaration", () => {
  it("declares one recent contributor as the solo class", () => {
    expect(descriptor(PCT_KEY).stats?.coSignalClass).toEqual({
      coSignal: "recentContributorCount",
      equals: 1,
      label: "solo",
    });
  });

  it("leaves blameDominantAuthorPct without a class", () => {
    expect(descriptor("git.file.blameDominantAuthorPct").stats?.coSignalClass).toBeUndefined();
  });

  it("declares no chunk-scope twin that would share the defect", () => {
    expect(gitPayloadSignalDescriptors.some((d) => d.key === "git.chunk.recentDominantAuthorPct")).toBe(false);
  });
});

describe("git.file.recentDominantAuthorPct — sampling with the real descriptors", () => {
  /** Twelve shared files and thirty solo ones, every solo file at 100%. */
  function points(): { payload: Record<string, unknown> }[] {
    const shared: [number, number][] = [
      [50, 2],
      [60, 2],
      [67, 3],
      [75, 4],
      [55, 2],
      [80, 5],
      [40, 3],
      [90, 2],
      [70, 3],
      [65, 2],
      [85, 4],
      [58, 2],
    ];
    const solo: [number, number][] = Array.from({ length: 30 }, () => [100, 1]);
    return [...shared, ...solo].map(([pct, contributors], i) => ({
      payload: {
        language: "typescript",
        chunkType: "function",
        isDocumentation: false,
        relativePath: `src/f${i}.ts`,
        git: { file: { recentDominantAuthorPct: pct, recentContributorCount: contributors, commitCount: 5 } },
      },
    }));
  }

  it("takes every threshold off the 100 maximum", () => {
    const stats = computeCollectionStats(points(), gitPayloadSignalDescriptors, gitStatsAccumulators);
    const pct = stats.perSignal.get(PCT_KEY)!;

    expect(pct.count).toBe(12);
    expect(pct.max).toBe(90);
    expect(pct.percentiles[95]).toBeLessThan(100);
  });
});

/** Minimal file-level preset surfacing the raw dominance overlay. */
class RecentDominanceProbePreset implements RerankPreset {
  readonly name = "recentDominanceProbe";
  readonly description = "Probe preset surfacing the raw recent-dominance overlay at file level";
  readonly tools = ["semantic_search"];
  readonly signalLevel = "file" as const;
  readonly weights: ScoringWeights = { similarity: 0.7, recentActivityConcentration: 0.3 };
  readonly overlayMask: OverlayMask = { file: ["recentDominantAuthorPct", "recentContributorCount"] };
}

describe("git.file.recentDominantAuthorPct — solo is labeled without a percentile", () => {
  const reranker = new Reranker(
    gitDerivedSignals,
    resolvePresets([new RecentDominanceProbePreset()], []),
    gitPayloadSignalDescriptors,
  );

  // A ladder cut over multi-contributor files only.
  const stats: CollectionSignalStats = {
    perSignal: new Map(),
    perLanguage: new Map([
      [
        "typescript",
        new Map([
          [PCT_KEY, { source: { count: 671, min: 33, max: 90, percentiles: { 25: 55, 50: 67, 75: 75, 95: 88 } } }],
        ]),
      ],
    ]),
    distributions: {
      totalFiles: 3020,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 3020 },
      topAuthors: [],
      topBlameAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };

  const filePoint = (pct: number, contributors: number, language = "typescript"): RerankableResult => ({
    score: 0.8,
    payload: {
      relativePath: "src/a.ts",
      startLine: 1,
      endLine: 50,
      language,
      chunkType: "function",
      git: { file: { recentDominantAuthorPct: pct, recentContributorCount: contributors } },
    },
  });

  it("labels a one-contributor file solo, not silo", async () => {
    reranker.setCollectionStats(stats);

    const ranked = await reranker.rerank([filePoint(100, 1)], "recentDominanceProbe", "semantic_search");

    expect(ranked[0].rankingOverlay!.file!.recentDominantAuthorPct).toEqual({ value: 100, label: "solo" });

    reranker.invalidateStats();
  });

  it("labels a one-contributor file solo even where the language carries no ladder", async () => {
    reranker.setCollectionStats(stats);

    const ranked = await reranker.rerank([filePoint(100, 1, "ruby")], "recentDominanceProbe", "semantic_search");

    expect(ranked[0].rankingOverlay!.file!.recentDominantAuthorPct).toEqual({ value: 100, label: "solo" });

    reranker.invalidateStats();
  });

  it("grades a multi-contributor file on the ladder", async () => {
    reranker.setCollectionStats(stats);

    const high = await reranker.rerank([filePoint(90, 2)], "recentDominanceProbe", "semantic_search");
    const low = await reranker.rerank([filePoint(40, 4)], "recentDominanceProbe", "semantic_search");

    expect(high[0].rankingOverlay!.file!.recentDominantAuthorPct).toEqual({ value: 90, label: "silo" });
    expect(low[0].rankingOverlay!.file!.recentDominantAuthorPct).toEqual({ value: 40, label: "shared" });

    reranker.invalidateStats();
  });
});
