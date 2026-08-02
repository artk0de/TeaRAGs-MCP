/**
 * `get_index_metrics` / prime labelMaps under industry floors — spec
 * docs/superpowers/specs/2026-08-02-module-mass-signals-design.md.
 *
 * The floors reach the same labelMap prime renders, so a clean TypeScript
 * project stops reporting a 35-line file as a god module while its test scope
 * keeps purely project-relative thresholds.
 */

import { describe, expect, it, vi } from "vitest";

import type { SignalFloors } from "../../../../../src/core/contracts/types/trajectory.js";
import { IndexMetricsQuery } from "../../../../../src/core/domains/explore/queries/index-metrics.js";

const FLOORS = new Map<string, SignalFloors>([
  ["typescript", { moduleLines: { large: 300, "god-module": 600 } }],
]);

/** Source percentiles sit far below the floors; test percentiles are separate. */
function makeDeps() {
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    getCollectionInfo: vi.fn().mockResolvedValue({ pointsCount: 100 }),
    getPoint: vi.fn().mockResolvedValue(null),
  } as never;

  const statsCache = {
    load: vi.fn().mockReturnValue({
      perSignal: new Map(),
      perLanguage: new Map([
        [
          "typescript",
          new Map([
            [
              "moduleLines",
              {
                source: { count: 40, min: 8, max: 120, percentiles: { 50: 26, 75: 31, 95: 35 } },
                test: { count: 30, min: 20, max: 400, percentiles: { 50: 90, 75: 180, 95: 260 } },
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
      computedAt: 1,
    }),
  } as never;

  const payloadSignals = [
    {
      key: "moduleLines",
      type: "number",
      description: "Physical line count of the file",
      stats: { labels: { p50: "small", p75: "large", p95: "god-module" }, dedupeByFile: true },
    },
  ] as never;

  return { qdrant, statsCache, payloadSignals };
}

describe("IndexMetricsQuery — industry floors", () => {
  it("raises source thresholds that sit below the language's published limits", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals, FLOORS);

    const result = await query.run("col", "/project");

    const source = result.signals["typescript"]["moduleLines"]["source"];
    expect(source.labelMap).toEqual({ small: 26, large: 300, "god-module": 600 });
  });

  it("leaves test scope purely percentile-derived", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals, FLOORS);

    const result = await query.run("col", "/project");

    const test = result.signals["typescript"]["moduleLines"]["test"];
    expect(test.labelMap).toEqual({ small: 90, large: 180, "god-module": 260 });
  });

  it("reports raw percentiles when no floors are wired at all", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals);

    const result = await query.run("col", "/project");

    expect(result.signals["typescript"]["moduleLines"]["source"].labelMap).toEqual({
      small: 26,
      large: 31,
      "god-module": 35,
    });
  });

  it("reports raw percentiles for a language that declares no floors", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals, new Map([["ruby", {}]]));

    const result = await query.run("col", "/project");

    expect(result.signals["typescript"]["moduleLines"]["source"].labelMap["god-module"]).toBe(35);
  });

  it("keeps min/max/count reporting the real distribution, not the floored one", async () => {
    const { qdrant, statsCache, payloadSignals } = makeDeps();
    const query = new IndexMetricsQuery(qdrant, statsCache, payloadSignals, FLOORS);

    const result = await query.run("col", "/project");

    const source = result.signals["typescript"]["moduleLines"]["source"];
    expect(source.min).toBe(8);
    expect(source.max).toBe(120);
    expect(source.count).toBe(40);
  });
});
