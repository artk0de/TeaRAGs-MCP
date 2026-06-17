/**
 * resolveFilterSpec — search-stage filter resolution.
 *
 * Covers the {presets} + replace-semantics + CSV-resolution helper that
 * ExploreOps.buildFilter consults BEFORE handing the resolved raw filter to
 * the registry's buildMergedFilter. The helper owns:
 *   - REPLACE semantics (explicit param wins; preset default only fills empty)
 *   - empty-object clear of the preset default
 *   - {presets} CSV resolution → compileFilterPreset → mergeQdrantFilters
 *   - typed errors for unknown / empty preset names
 *
 * Tested as a standalone exported function with stub registry + stub stats —
 * full ExploreOps construction is unnecessary to exercise the resolution logic.
 */

import { describe, expect, it } from "vitest";

import { resolveFilterSpec } from "../../../../src/core/api/internal/ops/explore-ops.js";
import { EmptyFilterPresetError, UnknownFilterPresetError } from "../../../../src/core/domains/explore/errors.js";
import type { FilterPresetDef, FilterSpec } from "../../../../src/core/contracts/types/filter-preset.js";

// ---------------------------------------------------------------------------
// Stub filter-preset definitions
// ---------------------------------------------------------------------------

const productionDef: FilterPresetDef = {
  name: "production",
  description: "exclude tests",
  conditions: [{ signal: "isTest", op: "eq", value: true, occur: "must_not" }],
};

const godMethodsDef: FilterPresetDef = {
  name: "godMethods",
  description: "very large chunks",
  conditions: [{ signal: "git.chunk.commitCount", op: "gte", value: 100, occur: "must" }],
};

function stubRegistry(defs: FilterPresetDef[]): {
  getFilterPresetDef: (name: string) => FilterPresetDef | undefined;
} {
  const map = new Map(defs.map((d) => [d.name, d]));
  return { getFilterPresetDef: (name: string) => map.get(name) };
}

const registry = stubRegistry([productionDef, godMethodsDef]);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("resolveFilterSpec", () => {
  it("passes a raw filter through unchanged", () => {
    const raw: FilterSpec = { must: [{ key: "language", match: { value: "ruby" } }] };
    const result = resolveFilterSpec(raw, undefined, undefined, "chunk", registry);
    expect(result).toEqual(raw);
  });

  it("compiles {presets:'production'} to the production filter (must_not isTest)", () => {
    const result = resolveFilterSpec({ presets: "production" }, undefined, undefined, "chunk", registry);
    expect(result).toEqual({ must_not: [{ key: "isTest", match: { value: true } }] });
  });

  it("applies the preset default when the param is undefined", () => {
    const result = resolveFilterSpec(undefined, { presets: "production" }, undefined, "chunk", registry);
    expect(result).toEqual({ must_not: [{ key: "isTest", match: { value: true } }] });
  });

  it("lets an explicit param REPLACE the preset default (godMethods, not production)", () => {
    const result = resolveFilterSpec({ presets: "godMethods" }, { presets: "production" }, undefined, "chunk", registry);
    expect(result).toEqual({ must: [{ key: "git.chunk.commitCount", range: { gte: 100 } }] });
    expect(JSON.stringify(result)).not.toContain("isTest");
  });

  it("treats an empty object as an explicit clear of the preset default", () => {
    const result = resolveFilterSpec({}, { presets: "production" }, undefined, "chunk", registry);
    expect(result).toBeUndefined();
  });

  it("returns undefined when neither param nor default is given", () => {
    const result = resolveFilterSpec(undefined, undefined, undefined, "chunk", registry);
    expect(result).toBeUndefined();
  });

  it("throws UnknownFilterPresetError for an unregistered name", () => {
    expect(() => resolveFilterSpec({ presets: "nope" }, undefined, undefined, "chunk", registry)).toThrow(
      UnknownFilterPresetError,
    );
  });

  it("throws EmptyFilterPresetError when the CSV has no resolvable names", () => {
    expect(() => resolveFilterSpec({ presets: " , " }, undefined, undefined, "chunk", registry)).toThrow(
      EmptyFilterPresetError,
    );
  });

  it("AND-merges multiple CSV presets", () => {
    const result = resolveFilterSpec(
      { presets: "production,godMethods" },
      undefined,
      undefined,
      "chunk",
      registry,
    );
    expect(result).toEqual({
      must: [{ key: "git.chunk.commitCount", range: { gte: 100 } }],
      must_not: [{ key: "isTest", match: { value: true } }],
    });
  });
});
