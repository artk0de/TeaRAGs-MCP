import { describe, expect, it } from "vitest";

import type { ResolveRunScope } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  AncestorLinearizerCache,
  type AncestorLinearizationPolicy,
  type AncestorLinearizerCacheContext,
} from "../../../../../src/core/domains/language/kernel/ancestor-walk.js";

/**
 * The cache is exercised through a HAND-BUILT policy, never Ruby's or Python's:
 * what is under test is WHEN a run's linearizer is rebuilt, not what order any
 * language produces.
 */
interface Ctx extends AncestorLinearizerCacheContext {
  readonly classAncestors?: Readonly<Record<string, readonly string[]>>;
  readonly companion?: object;
}

/** A symbol table whose size the test moves by hand. */
function table(size: number): { size: () => number; grow: () => void } {
  let n = size;
  return {
    size: () => n,
    grow: () => {
      n += 1;
    },
  };
}

function countingCache(companionsOf?: (ctx: Ctx) => readonly unknown[]): {
  cache: AncestorLinearizerCache<Ctx, AncestorLinearizationPolicy<Ctx>>;
  builds: () => number;
} {
  let built = 0;
  const cache = new AncestorLinearizerCache<Ctx, AncestorLinearizationPolicy<Ctx>>({
    createPolicy: () => {
      built += 1;
      return {
        order: (classKey, ctx, _recurse, insertable) => {
          const out = [classKey];
          for (const parent of ctx.classAncestors?.[classKey] ?? []) out.push(...insertable(parent, [out]));
          return out;
        },
      };
    },
    companionsOf,
  });
  return { cache, builds: () => built };
}

describe("AncestorLinearizerCache", () => {
  it("builds the linearizer once for the same classAncestors object at the same table size", () => {
    const { cache, builds } = countingCache();
    const symbolTable = table(3);
    const classAncestors = { A: ["B"] };
    const first = cache.for({ classAncestors, symbolTable });
    const second = cache.for({ classAncestors, symbolTable });
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(builds()).toBe(1);
    expect(first?.linearize("A").order).toEqual(["A", "B"]);
  });

  it("rebuilds when a new classAncestors object arrives", () => {
    const { cache, builds } = countingCache();
    const symbolTable = table(3);
    const first = cache.for({ classAncestors: { A: ["B"] }, symbolTable });
    const second = cache.for({ classAncestors: { A: ["C"] }, symbolTable });
    expect(second).not.toBe(first);
    expect(builds()).toBe(2);
    expect(second?.linearize("A").order).toEqual(["A", "C"]);
  });

  it("rebuilds when the same classAncestors object is seen against a grown table", () => {
    const { cache, builds } = countingCache();
    const symbolTable = table(3);
    const classAncestors: Record<string, string[]> = { A: ["B"] };
    const first = cache.for({ classAncestors, symbolTable });
    expect(first?.linearize("A").order).toEqual(["A", "B"]);
    // The run-global channel is written IN PLACE while the table grows — the
    // memoised linearization must not outlive that growth.
    classAncestors.A = ["B", "C"];
    symbolTable.grow();
    const second = cache.for({ classAncestors, symbolTable });
    expect(second).not.toBe(first);
    expect(builds()).toBe(2);
    expect(second?.linearize("A").order).toEqual(["A", "B", "C"]);
  });

  it("rebuilds when the same object is seen against a different table of the same size", () => {
    const { cache, builds } = countingCache();
    const classAncestors = { A: ["B"] };
    cache.for({ classAncestors, symbolTable: table(3) });
    cache.for({ classAncestors, symbolTable: table(3) });
    expect(builds()).toBe(2);
  });

  it("keeps one entry per run scope", () => {
    const { cache, builds } = countingCache();
    const symbolTable = table(3);
    const classAncestors = { A: ["B"] };
    const runA: ResolveRunScope = { runSeq: 1 };
    const runB: ResolveRunScope = { runSeq: 2 };
    const a = cache.for({ classAncestors, symbolTable, runScope: runA });
    const b = cache.for({ classAncestors, symbolTable, runScope: runB });
    expect(b).not.toBe(a);
    // Interleaved runs keep their own entries instead of evicting each other.
    expect(cache.for({ classAncestors, symbolTable, runScope: runA })).toBe(a);
    expect(builds()).toBe(2);
  });

  it("rebuilds when a declared companion channel changes identity", () => {
    const { cache, builds } = countingCache((ctx) => [ctx.companion]);
    const symbolTable = table(3);
    const classAncestors = { A: ["B"] };
    const first = cache.for({ classAncestors, symbolTable, companion: {} });
    expect(cache.for({ classAncestors, symbolTable, companion: {} })).not.toBe(first);
    expect(builds()).toBe(2);
  });

  it("answers undefined when the context carries no classAncestors or no symbol table", () => {
    const { cache, builds } = countingCache();
    expect(cache.for({ symbolTable: table(1) })).toBeUndefined();
    expect(cache.for({ classAncestors: { A: [] } })).toBeUndefined();
    expect(builds()).toBe(0);
  });

  it("exposes the policy of the entry it last handed out", () => {
    const { cache } = countingCache();
    expect(cache.currentPolicy).toBeUndefined();
    cache.for({ classAncestors: { A: [] }, symbolTable: table(1) });
    expect(cache.currentPolicy).toBeDefined();
  });
});
