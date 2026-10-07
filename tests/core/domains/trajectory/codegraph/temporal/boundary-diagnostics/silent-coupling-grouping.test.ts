/**
 * `groupSilentCouplingPairs` (bd tea-rags-mcp-89k7k.1.14, presentation): one
 * file significantly co-changing with many partners is listed as ONE group, not
 * one row per pair. Greedy by the endpoint holding the most ungrouped pairs,
 * ties by code-point order; every pair lands in exactly one group or stays a
 * singleton.
 */
import { describe, expect, it } from "vitest";

import { groupSilentCouplingPairs } from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

const pair = (relPathA: string, relPathB: string) => ({ relPathA, relPathB });

describe("groupSilentCouplingPairs", () => {
  it("groups three pairs sharing one endpoint and leaves an unrelated pair a singleton", () => {
    const pairs = [
      pair("app/a.ts", "config/en.yml"),
      pair("lib/x.ts", "lib/y.ts"),
      pair("app/b.ts", "config/en.yml"),
      pair("app/c.ts", "config/en.yml"),
    ];
    const grouping = groupSilentCouplingPairs(pairs);
    expect(grouping.groups).toEqual([{ relPath: "config/en.yml", pairs: [pairs[0], pairs[2], pairs[3]] }]);
    expect(grouping.singletons).toEqual([pairs[1]]);
  });

  it("loses no pair and lists none twice: greedy takes the busiest endpoint first, then re-counts", () => {
    // hub.yml holds 4 pairs, app/a.ts 3 (one shared with hub): hub takes its
    // 4 first, then app/a.ts re-counts to the 2 it still holds alone.
    const pairs = [
      pair("app/a.ts", "hub.yml"),
      pair("app/b.ts", "hub.yml"),
      pair("app/c.ts", "hub.yml"),
      pair("app/d.ts", "hub.yml"),
      pair("app/a.ts", "lib/p.ts"),
      pair("app/a.ts", "lib/q.ts"),
      pair("z/1.ts", "z/2.ts"),
    ];
    const grouping = groupSilentCouplingPairs(pairs);
    expect(grouping.groups.map((g) => [g.relPath, g.pairs.length])).toEqual([
      ["hub.yml", 4],
      ["app/a.ts", 2],
    ]);
    expect(grouping.singletons).toEqual([pairs[6]]);
    const listed = [...grouping.groups.flatMap((g) => g.pairs), ...grouping.singletons];
    expect(listed).toHaveLength(pairs.length);
    expect(new Set(listed)).toEqual(new Set(pairs));
  });

  it("breaks a tie between equally busy endpoints by code-point order, whatever the input order", () => {
    const pairs = [pair("b.ts", "m1.ts"), pair("b.ts", "m2.ts"), pair("a.ts", "n1.ts"), pair("a.ts", "n2.ts")];
    const forward = groupSilentCouplingPairs(pairs);
    const reversed = groupSilentCouplingPairs([...pairs].reverse());
    expect(forward.groups.map((g) => g.relPath)).toEqual(["a.ts", "b.ts"]);
    expect(reversed.groups.map((g) => g.relPath)).toEqual(["a.ts", "b.ts"]);
  });

  it("an endpoint with a single pair forms no group", () => {
    const pairs = [pair("a.ts", "b.ts"), pair("c.ts", "d.ts")];
    expect(groupSilentCouplingPairs(pairs)).toEqual({ groups: [], singletons: pairs });
  });
});
