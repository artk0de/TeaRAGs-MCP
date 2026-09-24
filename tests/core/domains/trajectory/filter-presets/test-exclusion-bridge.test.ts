/**
 * bd tea-rags-mcp-9ty5z — query-time bridge for indexes built before `isTest`
 * became path-aware. Every filter preset that excludes tests by `isTest` also
 * excludes points the codegraph policy stamped `skippedAs: "test"`, and so does
 * the typed `testFile: "exclude"` param — one owner for both.
 *
 * The preset set is DERIVED from the definitions the composition assembles,
 * never hand-listed, so a new test-excluding preset is covered on arrival.
 */

import { describe, expect, it } from "vitest";

import { assembleFilterPresets } from "../../../../../src/core/api/internal/composition.js";
import type { FilterPresetDef } from "../../../../../src/core/contracts/types/filter-preset.js";
import { compileFilterPreset } from "../../../../../src/core/domains/trajectory/filter-presets/compiler.js";
import { staticFilters } from "../../../../../src/core/domains/trajectory/static/filters.js";
import {
  isTestExclusionCondition,
  TEST_EXCLUSION_FILTER_CONDITIONS,
} from "../../../../../src/core/domains/trajectory/static/test-exclusion.js";

const BRIDGE = { key: "codegraph.symbols.file.skippedAs", match: { value: "test" } };
const IS_TEST = { key: "isTest", match: { value: true } };

const ALL_PRESETS: FilterPresetDef[] = assembleFilterPresets(new Set(["static", "git", "codegraph.symbols"]));
const TEST_EXCLUDING = ALL_PRESETS.filter((p) => p.conditions.some(isTestExclusionCondition));
const OTHERS = ALL_PRESETS.filter((p) => !p.conditions.some(isTestExclusionCondition));

describe("test-exclusion bridge (bd tea-rags-mcp-9ty5z)", () => {
  it("the shared condition set is isTest plus the codegraph skippedAs stamp", () => {
    expect(TEST_EXCLUSION_FILTER_CONDITIONS).toEqual([IS_TEST, BRIDGE]);
  });

  it("derives a non-empty set of test-excluding presets from the definitions", () => {
    expect(TEST_EXCLUDING.map((p) => p.name)).toEqual(expect.arrayContaining(["production", "coreLogic"]));
  });

  for (const preset of TEST_EXCLUDING) {
    it(`${preset.name}: compiled must_not carries the bridge beside isTest`, () => {
      const filter = compileFilterPreset(preset, undefined, "chunk");
      expect(filter.must_not).toContainEqual(IS_TEST);
      expect(filter.must_not).toContainEqual(BRIDGE);
    });
  }

  for (const preset of OTHERS) {
    it(`${preset.name}: does not exclude tests, so it gets no bridge`, () => {
      const filter = compileFilterPreset(preset, undefined, "chunk");
      expect(JSON.stringify(filter)).not.toContain("skippedAs");
    });
  }

  it("testFile 'exclude' emits exactly the shared condition set", () => {
    const f = staticFilters.find((c) => c.param === "testFile")!;
    expect(f.toCondition("exclude").must_not).toEqual(TEST_EXCLUSION_FILTER_CONDITIONS);
  });

  it("recognises only the must_not isTest=true shape as a test exclusion", () => {
    expect(isTestExclusionCondition({ signal: "isTest", op: "eq", value: true, occur: "must_not" })).toBe(true);
    expect(isTestExclusionCondition({ signal: "isTest", op: "eq", value: true })).toBe(false);
    expect(isTestExclusionCondition({ signal: "isTest", op: "eq", value: false, occur: "must_not" })).toBe(false);
    expect(isTestExclusionCondition({ signal: "isDocumentation", op: "eq", value: true, occur: "must_not" })).toBe(
      false,
    );
  });
});
