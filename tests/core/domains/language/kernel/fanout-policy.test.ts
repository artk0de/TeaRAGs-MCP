import { describe, expect, it } from "vitest";

import type { GlobalSymbolTable, SymbolDefinition } from "../../../../../src/core/contracts/types/codegraph.js";
import {
  buildDispatchFanoutPolicy,
  DISPATCH_FANOUT_CAP_FLOOR,
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
