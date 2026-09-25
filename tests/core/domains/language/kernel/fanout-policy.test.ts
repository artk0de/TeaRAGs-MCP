import { describe, expect, it } from "vitest";

import type { GlobalSymbolTable, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import type { DispatchFanoutPopulation } from "../../../../../src/core/contracts/types/language.js";
import {
  buildDispatchFanoutPolicy,
  DISPATCH_FANOUT_CAP_FLOOR,
  DISPATCH_FANOUT_POPULATION_MIN_MEMBERS,
  dispatchFanoutPolicyFor,
} from "../../../../../src/core/domains/language/kernel/fanout-policy.js";

const def = (id: string, relPath = `${id}.rb`): SymbolDefinition => ({
  symbolId: id,
  fqName: id,
  shortName: id.split("#")[1] ?? id,
  relPath,
  scope: [],
});

/** Minimal in-test GlobalSymbolTable: only what the policy reads. */
const tableWithCounts = (counts: Record<string, number>): GlobalSymbolTable => ({
  upsertFile: () => undefined,
  removeFile: () => undefined,
  lookup: () => [],
  lookupByShortName: (name) => Array.from({ length: counts[name] ?? 0 }, (_, i) => def(`C${i}#${name}`)),
  hasFile: () => false,
  hasFilesUnder: () => false,
  size: () => Object.values(counts).reduce((a, b) => a + b, 0),
  hydrate: () => undefined,
  shortNameDefCounts: () => new Map(Object.entries(counts)),
});

describe("buildDispatchFanoutPolicy", () => {
  it("floors the cap at DISPATCH_FANOUT_CAP_FLOOR for a flat corpus (p99 below floor)", () => {
    const counts = Array.from({ length: 100 }, () => 3); // every member has 3 defs
    const policy = buildDispatchFanoutPolicy(counts);
    expect(policy.cap).toBe(DISPATCH_FANOUT_CAP_FLOOR);
    expect(policy.p99DefsPerMember).toBe(3);
  });

  it("caps at the corpus p99 when the distribution has a heavy but narrow extreme tail", () => {
    // 985 members with 1 def, 10 with 20 defs, 5 ubiquitous ones with 500 defs
    // (the taxdome `#firm` shape). p99 (floor-index over 1000 sorted values)
    // lands on 20 — the extreme 0.5% is above the cap.
    const counts = [
      ...Array.from({ length: 985 }, () => 1),
      ...Array.from({ length: 10 }, () => 20),
      ...Array.from({ length: 5 }, () => 500),
    ];
    const policy = buildDispatchFanoutPolicy(counts);
    expect(policy.p99DefsPerMember).toBe(20);
    expect(policy.cap).toBe(20);
  });

  it("returns the floor for an empty corpus", () => {
    const policy = buildDispatchFanoutPolicy([]);
    expect(policy.cap).toBe(DISPATCH_FANOUT_CAP_FLOOR);
    expect(policy.p99DefsPerMember).toBe(0);
  });

  it("honours a custom floor", () => {
    expect(buildDispatchFanoutPolicy([1, 1], { floor: 8 }).cap).toBe(8);
  });
});

describe("dispatchFanoutPolicyFor", () => {
  it("computes the policy from the table's shortNameDefCounts", () => {
    const table = tableWithCounts({ m: 3, n: 1 });
    expect(dispatchFanoutPolicyFor(table).cap).toBe(DISPATCH_FANOUT_CAP_FLOOR);
  });

  it("memoizes per table instance — same object on repeated calls", () => {
    const table = tableWithCounts({ m: 2 });
    const first = dispatchFanoutPolicyFor(table);
    expect(dispatchFanoutPolicyFor(table)).toBe(first);
    expect(dispatchFanoutPolicyFor(tableWithCounts({ m: 2 }))).not.toBe(first);
  });
});

/**
 * Per-population p99 (bd tea-rags-mcp-nbf8q item 4). A table whose short names
 * carry `.rb` and `.ts` definitions in the given counts, so a population
 * predicate over the relPath sees only its own language's definitions.
 */
type PolyglotCounts = Record<string, { rb?: number; ts?: number }>;

const polyglotTable = (counts: PolyglotCounts): GlobalSymbolTable => ({
  upsertFile: () => undefined,
  removeFile: () => undefined,
  lookup: () => [],
  lookupByShortName: (name) => {
    const c = counts[name] ?? {};
    return [
      ...Array.from({ length: c.rb ?? 0 }, (_, i) => def(`R${i}#${name}`, `app/r${i}.rb`)),
      ...Array.from({ length: c.ts ?? 0 }, (_, i) => def(`T${i}#${name}`, `web/t${i}.ts`)),
    ];
  },
  hasFile: () => false,
  hasFilesUnder: () => false,
  size: () => Object.values(counts).reduce((a, c) => a + (c.rb ?? 0) + (c.ts ?? 0), 0),
  hydrate: () => undefined,
  shortNameDefCounts: () =>
    new Map(Object.entries(counts).map(([name, c]): [string, number] => [name, (c.rb ?? 0) + (c.ts ?? 0)])),
});

const RUBY: DispatchFanoutPopulation = { family: "ruby", ownsPath: (p) => p.endsWith(".rb") };

/**
 * The taxdome shape: Ruby alone has a p99 of 19, but 3,000 single-definition
 * TypeScript names drag the corpus p99 down to 1, so the corpus cap is the floor.
 */
const taxdomeShape = (rubyNames: number): PolyglotCounts => {
  const counts: PolyglotCounts = {};
  for (let i = 0; i < rubyNames - 15; i++) counts[`r${i}`] = { rb: 1 };
  for (let i = 0; i < 15; i++) counts[`hot${i}`] = { rb: 19 };
  for (let i = 0; i < 3000; i++) counts[`t${i}`] = { ts: 1 };
  return counts;
};

describe("dispatchFanoutPolicyFor — per-population p99 (nbf8q)", () => {
  it("reads the population's OWN p99, not the corpus one another language holds down", () => {
    const table = polyglotTable(taxdomeShape(DISPATCH_FANOUT_POPULATION_MIN_MEMBERS));
    expect(dispatchFanoutPolicyFor(table).cap).toBe(DISPATCH_FANOUT_CAP_FLOOR);
    const ruby = dispatchFanoutPolicyFor(table, { population: RUBY });
    expect(ruby.p99DefsPerMember).toBe(19);
    expect(ruby.cap).toBe(19);
  });

  it("counts only the population's definitions of a shared short name", () => {
    // Each `shared*` name is defined 40 times in TypeScript and once in Ruby:
    // for Ruby it is a 1, so it cannot lift the Ruby p99 above 19.
    const counts = taxdomeShape(DISPATCH_FANOUT_POPULATION_MIN_MEMBERS);
    for (let i = 0; i < 100; i++) counts[`shared${i}`] = { rb: 1, ts: 40 };
    const table = polyglotTable(counts);
    expect(dispatchFanoutPolicyFor(table).p99DefsPerMember).toBe(41);
    expect(dispatchFanoutPolicyFor(table, { population: RUBY }).p99DefsPerMember).toBe(19);
  });

  it("falls back to the corpus policy below the minimum member count", () => {
    const table = polyglotTable(taxdomeShape(DISPATCH_FANOUT_POPULATION_MIN_MEMBERS - 1));
    expect(dispatchFanoutPolicyFor(table, { population: RUBY })).toBe(dispatchFanoutPolicyFor(table));
  });

  it("memoizes per population family — same object on repeat, distinct per family", () => {
    const table = polyglotTable(taxdomeShape(DISPATCH_FANOUT_POPULATION_MIN_MEMBERS));
    const first = dispatchFanoutPolicyFor(table, { population: RUBY });
    expect(dispatchFanoutPolicyFor(table, { population: RUBY })).toBe(first);
    // 3,000 TypeScript names, each defined once: its own p99 is 1, so the floor.
    const ts: DispatchFanoutPopulation = { family: "ecmascript", ownsPath: (p) => p.endsWith(".ts") };
    const tsPolicy = dispatchFanoutPolicyFor(table, { population: ts });
    expect(tsPolicy).not.toBe(first);
    expect(tsPolicy.p99DefsPerMember).toBe(1);
  });

  it("memoizes per run scope — a new run recomputes the population policy", () => {
    const table = polyglotTable(taxdomeShape(DISPATCH_FANOUT_POPULATION_MIN_MEMBERS));
    const run1 = dispatchFanoutPolicyFor(table, { population: RUBY, runScope: { runSeq: 1 } });
    expect(dispatchFanoutPolicyFor(table, { population: RUBY, runScope: { runSeq: 2 } })).not.toBe(run1);
  });
});
