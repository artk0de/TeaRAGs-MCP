/**
 * LAST_COMMIT_TIME_FILTER_INDEXES ⟺ the git filter descriptors that range over
 * a last-commit timestamp (bd tea-rags-mcp-9mwny).
 *
 * `minAgeDays` / `maxAgeDays` compile to `git.<level>.lastModifiedAt` ranges
 * computed from query-time now; `modifiedAfter` / `modifiedBefore` range over
 * `git.file.lastModifiedAt`. The adapter layer may not import the domain, so
 * the index list is mirrored by hand — and an unindexed filter key does not
 * fail, it silently turns every such query into a full payload scan (measured
 * 1.4 ms → 304–441 ms for a count on the 24.6k-point self-index). Compared in
 * both directions, at both levels, because the age filters are level-aware.
 */

import { describe, expect, it } from "vitest";

import { LAST_COMMIT_TIME_FILTER_INDEXES } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import type { FilterLevel } from "../../../../src/core/contracts/types/provider.js";
import { gitFilters } from "../../../../src/core/domains/trajectory/git/filters.js";

const LEVELS: (FilterLevel | undefined)[] = [undefined, "file", "chunk"];

function sampleValue(param: string): unknown {
  return param.startsWith("modified") ? "2026-01-01" : 7;
}

function filterKeys(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) filterKeys(child, into);
  } else if (node && typeof node === "object") {
    const record = node as Record<string, unknown>;
    if (typeof record.key === "string") into.add(record.key);
    for (const value of Object.values(record)) filterKeys(value, into);
  }
  return into;
}

/** Every last-commit timestamp key a git filter can emit, at any level. */
function emittedTimestampKeys(): Set<string> {
  const keys = new Set<string>();
  for (const descriptor of gitFilters) {
    for (const level of LEVELS) {
      for (const key of filterKeys(descriptor.toCondition(sampleValue(descriptor.param), level))) {
        if (key.endsWith(".lastModifiedAt")) keys.add(key);
      }
    }
  }
  return keys;
}

describe("LAST_COMMIT_TIME_FILTER_INDEXES ⟺ git timestamp filters", () => {
  it("indexes every last-commit timestamp key a git filter emits", () => {
    const indexed = new Set(LAST_COMMIT_TIME_FILTER_INDEXES.map(({ path }) => path));
    expect([...emittedTimestampKeys()].filter((key) => !indexed.has(key))).toEqual([]);
  });

  it("indexes no timestamp key that no git filter emits", () => {
    const emitted = emittedTimestampKeys();
    expect(LAST_COMMIT_TIME_FILTER_INDEXES.map(({ path }) => path).filter((path) => !emitted.has(path))).toEqual([]);
  });

  // The stored value is a whole-second commit timestamp; a `datetime` or
  // `keyword` index would not serve the numeric range the filters send.
  it("indexes them as integer", () => {
    expect(LAST_COMMIT_TIME_FILTER_INDEXES.every(({ schema }) => schema === "integer")).toBe(true);
  });
});
