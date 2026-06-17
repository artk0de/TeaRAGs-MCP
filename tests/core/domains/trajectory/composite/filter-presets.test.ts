import { describe, it, expect } from "vitest";
import { buildCompositeFilterPresets } from "../../../../../src/core/domains/trajectory/composite/filter-presets/index.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";

describe("composite filter presets gating", () => {
  it("includes battleTested + abandonedHotspots when git registered", () => {
    const names = buildCompositeFilterPresets(new Set(["git", "codegraph.symbols", "static"])).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["battleTested", "abandonedHotspots"]));
  });

  it("drops all when git is not registered", () => {
    expect(buildCompositeFilterPresets(new Set(["static"]))).toEqual([]);
  });

  it("battleTested: old (p50 fb30) + low-bug (p25 fb10) + multi-author (>=2)", () => {
    const bt = buildCompositeFilterPresets(new Set(["git"])).find((p) => p.name === "battleTested")!;
    const f = compileFilterPreset(bt, undefined, "file");
    expect(f.must).toContainEqual({ key: "git.file.ageDays", range: { gte: 30 } });
    expect(f.must).toContainEqual({ key: "git.file.bugFixRate", range: { lte: 10 } });
    expect(f.must).toContainEqual({ key: "git.file.blameContributorCount", range: { gte: 2 } });
  });

  it("abandonedHotspots: high-churn (p75 fb9) + old (p75 fb42)", () => {
    const ah = buildCompositeFilterPresets(new Set(["git"])).find((p) => p.name === "abandonedHotspots")!;
    const f = compileFilterPreset(ah, undefined, "file");
    expect(f.must).toContainEqual({ key: "git.file.commitCount", range: { gte: 9 } });
    expect(f.must).toContainEqual({ key: "git.file.ageDays", range: { gte: 42 } });
  });
});
