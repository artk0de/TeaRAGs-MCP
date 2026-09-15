/**
 * `dispatchFanoutPolicyFor` memoises per RUN, not per symbol-table instance (bd
 * tea-rags-mcp-39xca.6).
 *
 * `GraphDbClientPool` keeps one `GlobalSymbolTable` per collection for the
 * pool's lifetime, so a memo keyed by the table froze the corpus-adaptive cap at
 * whatever the FIRST run's defs-per-member distribution was, for as long as the
 * process lived. The caller now hands the run's `runScope`; a new scope over the
 * same pooled table recomputes, the same scope serves the memo.
 */
import { describe, expect, it } from "vitest";

import type {
  GlobalSymbolTable,
  ResolveRunScope,
  SymbolDefinition,
} from "../../../../../src/core/contracts/types/codegraph.js";
import { dispatchFanoutPolicyFor } from "../../../../../src/core/domains/language/kernel/fanout-policy.js";

const def = (id: string): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id,
  relPath: `${id}.rb`,
  scope: [],
});

/** A pooled table whose defs-per-member distribution the test can move in place. */
function mutableTable(initial: Record<string, number>): {
  table: GlobalSymbolTable;
  set: (c: Record<string, number>) => void;
} {
  let counts = initial;
  const table: GlobalSymbolTable = {
    upsertFile: () => undefined,
    removeFile: () => undefined,
    lookup: () => [],
    lookupByShortName: (name) => Array.from({ length: counts[name] ?? 0 }, (_, i) => def(`C${i}#${name}`)),
    hasFile: () => false,
    hasFilesUnder: () => false,
    size: () => Object.values(counts).reduce((a, b) => a + b, 0),
    hydrate: () => undefined,
    shortNameDefCounts: () => new Map(Object.entries(counts)),
  };
  return { table, set: (next) => (counts = next) };
}

/** `n` members, each defined `defs` times: p99 = `defs`. */
const uniform = (n: number, defs: number): Record<string, number> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`m${i}`, defs]));

const scope = (runSeq: number): ResolveRunScope => ({ runSeq });

describe("dispatchFanoutPolicyFor — memoised per run scope", () => {
  it("recomputes the cap for the next run over the same pooled table", () => {
    const { table, set } = mutableTable(uniform(100, 20));
    const run1 = scope(1);
    expect(dispatchFanoutPolicyFor(table, { runScope: run1 }).cap).toBe(20);

    set(uniform(100, 40));
    expect(dispatchFanoutPolicyFor(table, { runScope: scope(2) }).cap).toBe(40);
  });

  it("serves the same policy object to every call of one run", () => {
    const { table } = mutableTable(uniform(100, 20));
    const run = scope(1);

    const first = dispatchFanoutPolicyFor(table, { runScope: run });
    expect(dispatchFanoutPolicyFor(table, { runScope: run })).toBe(first);
  });
});
