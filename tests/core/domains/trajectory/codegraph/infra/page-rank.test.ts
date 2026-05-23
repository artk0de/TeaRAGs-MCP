import { describe, expect, it } from "vitest";

import {
  pageRank,
  type AdjacencyMap,
} from "../../../../../../src/core/domains/trajectory/codegraph/infra/page-rank.js";

describe("pageRank", () => {
  it("returns an empty result for an empty graph", () => {
    const result = pageRank(new Map());
    expect(result.ranks.size).toBe(0);
    expect(result.converged).toBe(true);
  });

  it("assigns equal rank to nodes in a symmetric two-node cycle", () => {
    // A → B → A: every iteration preserves symmetry; both nodes
    // converge to 0.5 (sum = 1, no dangling nodes).
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const { ranks, converged } = pageRank(adj);
    expect(converged).toBe(true);
    expect(ranks.get("a")).toBeCloseTo(0.5, 5);
    expect(ranks.get("b")).toBeCloseTo(0.5, 5);
  });

  it("ranks a hub above its leaves", () => {
    // hub gets pointed at by a, b, c (all of whom have no other
    // out-edges → all rank flows through hub). hub's rank must
    // exceed every contributor's.
    const adj: AdjacencyMap = new Map([
      ["a", ["hub"]],
      ["b", ["hub"]],
      ["c", ["hub"]],
      ["hub", []],
    ]);
    const { ranks, converged } = pageRank(adj);
    expect(converged).toBe(true);
    const hub = ranks.get("hub") ?? 0;
    const leaf = ranks.get("a") ?? 0;
    expect(hub).toBeGreaterThan(leaf);
  });

  it("handles dangling nodes via uniform mass redistribution", () => {
    // c is dangling (zero out-degree). Without redistribution, total
    // rank would leak below 1 each iteration. With redistribution,
    // the total stays ≈ 1.
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    const { ranks, converged } = pageRank(adj);
    expect(converged).toBe(true);
    const total = [...ranks.values()].reduce((sum, r) => sum + r, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("infers target-only nodes (they only appear as edge destinations)", () => {
    // 'sink' never appears as a source key; pageRank must still
    // assign it a rank because it appears in the target list.
    const adj: AdjacencyMap = new Map([["source", ["sink"]]]);
    const { ranks } = pageRank(adj);
    expect(ranks.has("source")).toBe(true);
    expect(ranks.has("sink")).toBe(true);
    expect(ranks.size).toBe(2);
  });

  it("returns the last vector when not converged within maxIterations", () => {
    // Asymmetric graph (a hub + leaf + dangling redistribution)
    // takes multiple iterations to converge. A tiny budget + tight
    // epsilon forces a non-converged return; ranks are still sensible
    // (correct keys, positive values, total ≈ 1).
    const adj: AdjacencyMap = new Map([
      ["a", ["hub"]],
      ["b", ["hub"]],
      ["c", ["hub"]],
      ["hub", []],
    ]);
    const { ranks, converged, iterations } = pageRank(adj, { maxIterations: 1, epsilon: 1e-99 });
    expect(converged).toBe(false);
    expect(iterations).toBe(1);
    for (const v of ranks.values()) expect(v).toBeGreaterThan(0);
  });

  it("respects a custom damping factor", () => {
    // damping=1 (no teleport): rank only flows through edges.
    // damping=0 (all teleport): every node converges to 1/N
    // immediately regardless of structure.
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", []],
    ]);
    const { ranks: rZero } = pageRank(adj, { damping: 0, maxIterations: 10 });
    // With d=0, teleport=1/N and dangling redistribution still
    // distributes mass. After enough iterations the dist is uniform.
    expect(rZero.get("a")).toBeCloseTo(0.5, 5);
    expect(rZero.get("b")).toBeCloseTo(0.5, 5);
  });
});
