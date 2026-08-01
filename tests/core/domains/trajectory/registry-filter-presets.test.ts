// Registry owns filter-preset DATA only (set/get/list). CSV resolution, merge,
// and unknown/empty-preset errors are tested in the ExploreOps filter test (Task 11),
// which legally imports the compiler (trajectory) + errors (explore) + filter merge (adapters).

import { describe, expect, it } from "vitest";

import type { FilterPresetDef } from "../../../../src/core/contracts/types/filter-preset.js";
import { TrajectoryRegistry } from "../../../../src/core/domains/trajectory/index.js";

/** A static filter preset excluding test files (must_not isTest). */
const PRODUCTION_PRESET: FilterPresetDef = {
  name: "production",
  description: "Production code only — excludes test files.",
  conditions: [{ signal: "isTest", op: "eq", value: true, occur: "must_not" }],
};

/** A git filter preset gating high churn-ratio chunks ("god methods"). */
const GOD_METHODS_PRESET: FilterPresetDef = {
  name: "godMethods",
  description: "High-churn chunks — candidate god methods.",
  requires: ["git"],
  conditions: [{ signal: "git.chunk.churnRatio", op: "gte", value: 0.8 }],
};

describe("TrajectoryRegistry filter-preset data accessors", () => {
  it("returns the stored def by name after setFilterPresets", () => {
    const registry = new TrajectoryRegistry();
    registry.setFilterPresets([PRODUCTION_PRESET, GOD_METHODS_PRESET]);

    expect(registry.getFilterPresetDef("production")).toBe(PRODUCTION_PRESET);
    expect(registry.getFilterPresetDef("godMethods")).toBe(GOD_METHODS_PRESET);
  });

  it("returns undefined for an unknown preset name", () => {
    const registry = new TrajectoryRegistry();
    registry.setFilterPresets([PRODUCTION_PRESET]);

    expect(registry.getFilterPresetDef("nope")).toBeUndefined();
  });

  it("lists all registered filter-preset names", () => {
    const registry = new TrajectoryRegistry();
    registry.setFilterPresets([PRODUCTION_PRESET, GOD_METHODS_PRESET]);

    const names = registry.filterPresetNames();

    expect(names).toContain("production");
    expect(names).toContain("godMethods");
    expect(names).toHaveLength(2);
  });

  it("returns an empty array when no presets are set", () => {
    const registry = new TrajectoryRegistry();

    expect(registry.filterPresetNames()).toEqual([]);
    expect(registry.getFilterPresetDef("production")).toBeUndefined();
  });

  it("replaces the map on a subsequent setFilterPresets call", () => {
    const registry = new TrajectoryRegistry();
    registry.setFilterPresets([PRODUCTION_PRESET, GOD_METHODS_PRESET]);
    registry.setFilterPresets([PRODUCTION_PRESET]);

    expect(registry.filterPresetNames()).toEqual(["production"]);
    expect(registry.getFilterPresetDef("godMethods")).toBeUndefined();
  });
});
