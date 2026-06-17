import { describe, it, expect } from "vitest";

import type { CollectionSignalStats, SignalStats } from "../../../../../src/core/contracts/types/trajectory.js";
import type { FilterPresetDef } from "../../../../../src/core/contracts/types/filter-preset.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

/** Build a CollectionSignalStats stub with only the perSignal percentile data the compiler reads. */
function makeStats(entries: [string, Partial<SignalStats>][]): CollectionSignalStats {
  const perSignal = new Map<string, SignalStats>();
  for (const [key, stats] of entries) {
    perSignal.set(key, { count: 100, min: 0, max: 100, percentiles: {}, ...stats } as SignalStats);
  }
  return { perSignal } as unknown as CollectionSignalStats;
}

describe("compileFilterPreset", () => {
  it("compiles a literal gte threshold to a range condition", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "git.file.commitCount", op: "gte", value: 5 }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must: [{ key: "git.file.commitCount", range: { gte: 5 } }] });
  });

  it("resolves an adaptive percentile threshold from collection stats", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "git.file.commitCount", op: "gte", value: { percentile: "p75", fallback: 3 } }],
    };
    const stats = makeStats([["git.file.commitCount", { percentiles: { 75: 14 } }]]);
    const filter = compileFilterPreset(def, stats, "file");
    expect(filter).toEqual({ must: [{ key: "git.file.commitCount", range: { gte: 14 } }] });
  });

  it("uses fallback when stats lack the requested percentile (cold start)", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "git.file.commitCount", op: "gte", value: { percentile: "p75", fallback: 3 } }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must: [{ key: "git.file.commitCount", range: { gte: 3 } }] });
  });

  it("maps a codegraph logical key to its physical key for eq boolean", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "codegraph.file.isHub", op: "eq", value: true }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must: [{ key: "codegraph.symbols.file.isHub", match: { value: true } }] });
  });

  it("compiles a must_not eq to a must_not match condition", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "isTest", op: "eq", value: true, occur: "must_not" }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must_not: [{ key: "isTest", match: { value: true } }] });
  });

  it("compiles should-group conditions into a nested must:[{should:[...]}] group", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [
        { signal: "git.file.commitCount", op: "gte", value: 5 },
        { signal: "git.file.bugFixRate", op: "gte", value: 20, occur: "should" },
        { signal: "git.file.churnVolatility", op: "gte", value: 2, occur: "should" },
      ],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({
      must: [
        { key: "git.file.commitCount", range: { gte: 5 } },
        {
          should: [
            { key: "git.file.bugFixRate", range: { gte: 20 } },
            { key: "git.file.churnVolatility", range: { gte: 2 } },
          ],
        },
      ],
    });
  });

  it("compiles an eq with an array value to a match.any condition", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "chunkType", op: "eq", value: ["function", "class"] }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must: [{ key: "chunkType", match: { any: ["function", "class"] } }] });
  });

  it("compiles a contains op to a match.text condition", () => {
    const def: FilterPresetDef = {
      name: "p",
      description: "d",
      conditions: [{ signal: "relativePath", op: "contains", value: "auth/" }],
    };
    const filter = compileFilterPreset(def, undefined, "file");
    expect(filter).toEqual({ must: [{ key: "relativePath", match: { text: "auth/" } }] });
  });
});
