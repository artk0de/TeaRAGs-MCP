import { describe, expect, it } from "vitest";

import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsPoint,
} from "../../../../../../src/core/contracts/types/stats-accumulator.js";
import {
  ChunkTypeCountsAccumulator,
  DistinctPathsAccumulator,
  DocsCodeCountsAccumulator,
  LanguageCountsAccumulator,
  staticStatsAccumulators,
} from "../../../../../../src/core/domains/trajectory/static/stats/index.js";

function ctx(overrides: Partial<PointContext> = {}): PointContext {
  return {
    pointChunkType: "function",
    lang: "typescript",
    isCodeLanguage: true,
    relPath: "src/a.ts",
    scope: "source",
    ...overrides,
  };
}

const POINT: StatsPoint = { payload: {} };

describe("LanguageCountsAccumulator", () => {
  it("counts occurrences per language", () => {
    const acc = new LanguageCountsAccumulator();
    acc.accept(POINT, ctx({ lang: "typescript" }));
    acc.accept(POINT, ctx({ lang: "typescript" }));
    acc.accept(POINT, ctx({ lang: "python" }));
    expect(acc.result()).toEqual({ typescript: 2, python: 1 });
  });

  it("ignores points with undefined lang", () => {
    const acc = new LanguageCountsAccumulator();
    acc.accept(POINT, ctx({ lang: undefined, isCodeLanguage: false }));
    expect(acc.result()).toEqual({});
  });
});

describe("ChunkTypeCountsAccumulator", () => {
  it("counts per chunkType from context", () => {
    const acc = new ChunkTypeCountsAccumulator();
    acc.accept(POINT, ctx({ pointChunkType: "function" }));
    acc.accept(POINT, ctx({ pointChunkType: "class" }));
    acc.accept(POINT, ctx({ pointChunkType: "function" }));
    expect(acc.result()).toEqual({ function: 2, class: 1 });
  });

  it("ignores points with undefined chunkType", () => {
    const acc = new ChunkTypeCountsAccumulator();
    acc.accept(POINT, ctx({ pointChunkType: undefined }));
    expect(acc.result()).toEqual({});
  });
});

describe("DocsCodeCountsAccumulator", () => {
  it("counts documentation vs code", () => {
    const acc = new DocsCodeCountsAccumulator();
    acc.accept({ payload: { isDocumentation: true } }, ctx());
    acc.accept({ payload: { isDocumentation: true } }, ctx());
    acc.accept({ payload: {} }, ctx());
    acc.accept({ payload: { isDocumentation: false } }, ctx());
    expect(acc.result()).toEqual({ docsCount: 2, codeCount: 2 });
  });
});

describe("DistinctPathsAccumulator", () => {
  it("collects unique relPaths", () => {
    const acc = new DistinctPathsAccumulator();
    acc.accept(POINT, ctx({ relPath: "a.ts" }));
    acc.accept(POINT, ctx({ relPath: "a.ts" }));
    acc.accept(POINT, ctx({ relPath: "b.ts" }));
    expect(acc.result().size).toBe(2);
    expect(acc.result().has("a.ts")).toBe(true);
    expect(acc.result().has("b.ts")).toBe(true);
  });

  it("skips empty relPath", () => {
    const acc = new DistinctPathsAccumulator();
    acc.accept(POINT, ctx({ relPath: "" }));
    expect(acc.result().size).toBe(0);
  });
});

describe("staticStatsAccumulators barrel", () => {
  it("exports four descriptors with well-known keys", () => {
    expect(staticStatsAccumulators).toHaveLength(4);
    const keys = staticStatsAccumulators.map((d) => d.key);
    expect(keys).toEqual([
      STATS_ACCUMULATOR_KEYS.LANGUAGE_COUNTS,
      STATS_ACCUMULATOR_KEYS.CHUNK_TYPE_COUNTS,
      STATS_ACCUMULATOR_KEYS.DOCS_CODE_COUNTS,
      STATS_ACCUMULATOR_KEYS.DISTINCT_PATHS,
    ]);
  });

  it("each factory produces an independent instance", () => {
    const descriptor = staticStatsAccumulators[0];
    if (!descriptor) throw new Error("staticStatsAccumulators is unexpectedly empty");
    const a = descriptor.factory();
    const b = descriptor.factory();
    a.accept(POINT, ctx({ lang: "typescript" }));
    expect(a.result()).not.toBe(b.result());
  });
});
