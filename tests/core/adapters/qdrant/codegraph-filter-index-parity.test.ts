/**
 * CODEGRAPH_FILTER_INDEXES ⟺ the codegraph filter descriptors (bd tea-rags-mcp-hzf32).
 *
 * `CODEGRAPH_FILTER_INDEXES` lists the Qdrant payload indexes schema v15 creates;
 * `codegraphFilters` and `CODEGRAPH_FILTER_PRESETS` are what actually addresses
 * those paths at query time. The adapter layer may not import the domain
 * (domain-boundaries rule), so the list is mirrored by hand — and a mirror has
 * two failure modes, both silent:
 *
 *  - a filterable key with no index: Qdrant answers the condition by fetching
 *    every candidate's payload, so the filter still returns the right rows and
 *    only the latency says anything (measured 3,274 ms → 6 ms on taxdome when
 *    the enrichment-scan indexes were added);
 *  - an index with no filter: a field index maintained on every upsert that no
 *    query path can ever use.
 *
 * Neither shows up in a green suite, which is why this file compares the two
 * sets in BOTH directions. Tests may import both sides — the layer rule binds
 * `src/`, not `tests/`.
 */

import { describe, expect, it } from "vitest";

import { CODEGRAPH_FILTER_INDEXES } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import type { FilterLevel } from "../../../../src/core/contracts/types/provider.js";
import { CODEGRAPH_FILTER_PRESETS } from "../../../../src/core/domains/trajectory/codegraph/symbols/filter-presets/index.js";
import { codegraphFilters } from "../../../../src/core/domains/trajectory/codegraph/symbols/filters.js";
import { compileFilterPreset } from "../../../../src/core/domains/trajectory/filter-presets/compiler.js";

/** Both payload levels, because a level-aware descriptor resolves a different key per level. */
const LEVELS: FilterLevel[] = ["file", "chunk"];

/** Every path the mirror is responsible for. Non-codegraph keys belong to other trajectories. */
const CODEGRAPH_PATH_PREFIX = "codegraph.";

/**
 * A value of the descriptor's declared type, so `toCondition` builds the same
 * condition shape a user's call would. The value itself never reaches the
 * assertion — only the `key` the descriptor chose for it does.
 */
function sampleValue(type: string): unknown {
  switch (type) {
    case "boolean":
      return true;
    case "number":
      return 1;
    case "string[]":
      return ["sample"];
    default:
      return "sample";
  }
}

/**
 * Collect every `key` a compiled filter names, at any nesting depth. Both
 * producers emit `must` / `must_not` arrays, and the preset compiler can nest a
 * `{ should: [...] }` group inside `must`, so this walks rather than indexes.
 */
function filterKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) filterKeys(item, into);
    return into;
  }
  if (typeof node !== "object" || node === null) return into;
  for (const [field, value] of Object.entries(node)) {
    if (field === "key" && typeof value === "string") into.add(value);
    else filterKeys(value, into);
  }
  return into;
}

/** Payload paths the typed `minFanIn` / `isHub` / … params resolve to, per level. */
function keysFromDescriptors(): Set<string> {
  const keys = new Set<string>();
  for (const descriptor of codegraphFilters) {
    for (const level of LEVELS) {
      for (const key of filterKeys(descriptor.toCondition(sampleValue(descriptor.type), level))) {
        keys.add(key);
      }
    }
  }
  return keys;
}

/** Payload paths the named filter presets (`hubs`, `deadCandidates`, …) resolve to. */
function keysFromPresets(): Set<string> {
  const keys = new Set<string>();
  for (const preset of CODEGRAPH_FILTER_PRESETS) {
    for (const level of LEVELS) {
      // Cold start: no collection stats, so adaptive percentiles take their
      // fallback. The threshold never changes which key the condition names.
      for (const key of filterKeys(compileFilterPreset(preset, undefined, level))) keys.add(key);
    }
  }
  return keys;
}

/** Which descriptor types produced each path — the input to the index-schema check. */
function descriptorTypesByKey(): Map<string, Set<string>> {
  const byKey = new Map<string, Set<string>>();
  for (const descriptor of codegraphFilters) {
    for (const level of LEVELS) {
      for (const key of filterKeys(descriptor.toCondition(sampleValue(descriptor.type), level))) {
        const types = byKey.get(key) ?? new Set<string>();
        types.add(descriptor.type);
        byKey.set(key, types);
      }
    }
  }
  return byKey;
}

describe("CODEGRAPH_FILTER_INDEXES ⟺ codegraph filter descriptors (bd tea-rags-mcp-hzf32)", () => {
  const filterable = new Set(
    [...keysFromDescriptors(), ...keysFromPresets()].filter((key) => key.startsWith(CODEGRAPH_PATH_PREFIX)),
  );
  const indexed = new Set(CODEGRAPH_FILTER_INDEXES.map(({ path }) => path));

  it("indexes every codegraph payload path a filter addresses, and nothing else", () => {
    // Reported as one object so a failure names the offenders on both sides at
    // once: adding a signal without its index, and removing the last filter
    // that used an index, are the same edit seen from opposite ends.
    expect({
      filterableWithoutIndex: [...filterable].filter((key) => !indexed.has(key)).sort(),
      indexedWithoutFilter: [...indexed].filter((key) => !filterable.has(key)).sort(),
    }).toEqual({ filterableWithoutIndex: [], indexedWithoutFilter: [] });
  });

  it("gives each path an index schema the filter's own condition can use", () => {
    // A `range` condition on a path indexed as `keyword` is not served by that
    // index, and a `match` on a numeric index is not either — the path is
    // covered on paper and scans in practice.
    const typesByKey = descriptorTypesByKey();
    const wrong = CODEGRAPH_FILTER_INDEXES.filter(({ path, schema }) => {
      const types = typesByKey.get(path);
      if (!types) return false; // preset-only path; the descriptors say nothing about its type
      if (types.has("boolean")) return schema !== "bool";
      if (types.has("number")) return schema !== "integer" && schema !== "float";
      return false;
    }).map(({ path, schema }) => `${path}:${schema}`);

    expect(wrong).toEqual([]);
  });
});
