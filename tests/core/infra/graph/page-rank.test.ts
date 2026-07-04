import { describe, expect, it } from "vitest";

import { pageRank, type AdjacencyMap } from "../../../../src/core/infra/graph/page-rank.js";

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

  // bd tea-rags-mcp-s5ato — confidence-weighted edges. A dynamic dispatch
  // site fanning out to m candidates at confidence 1/m must distribute its
  // rank proportionally to those weights, not uniformly per edge row.
  describe("weighted edges", () => {
    it("distributes rank proportionally to edge weight instead of uniformly", () => {
      // A → B (0.9) and A → C (0.1). Unweighted PageRank splits A's mass
      // 50/50 (rank(B) === rank(C)); weighted must route 9× more to B.
      const adj: AdjacencyMap = new Map([["a", ["b", "c"]]]);
      const unweighted = pageRank(adj);
      expect(unweighted.ranks.get("b") ?? 0).toBeCloseTo(unweighted.ranks.get("c") ?? 0, 10);

      const { ranks, converged } = pageRank(adj, { weights: new Map([["a", [0.9, 0.1]]]) });
      expect(converged).toBe(true);
      expect(ranks.get("b") ?? 0).toBeGreaterThan(ranks.get("c") ?? 0);
    });

    it("all-1 weights reproduce the unweighted distribution exactly (regression pin)", () => {
      // Same math bit-for-bit: w=1 keeps outWeight === outDegree and each
      // contribution current·1/deg === current/deg. Guards backward compat
      // for every caller that passes no weights.
      const adj: AdjacencyMap = new Map([
        ["a", ["hub"]],
        ["b", ["hub"]],
        ["c", ["hub"]],
        ["hub", []],
      ]);
      const unweighted = pageRank(adj);
      const weighted = pageRank(adj, {
        weights: new Map([
          ["a", [1]],
          ["b", [1]],
          ["c", [1]],
        ]),
      });
      expect(Object.fromEntries(weighted.ranks)).toEqual(Object.fromEntries(unweighted.ranks));
      expect(weighted.iterations).toBe(unweighted.iterations);
    });

    it("sources absent from the weight map default every edge to weight 1", () => {
      // Only 'a' carries an entry; 'b' falls back to uniform weight-1 edges.
      const adj: AdjacencyMap = new Map([
        ["a", ["b", "c"]],
        ["b", ["c"]],
      ]);
      const partial = pageRank(adj, { weights: new Map([["a", [1, 1]]]) });
      const unweighted = pageRank(adj);
      expect(Object.fromEntries(partial.ranks)).toEqual(Object.fromEntries(unweighted.ranks));
    });

    it("treats a source whose total edge weight is 0 as dangling (no division by zero)", () => {
      // b's only edge weighs 0 → b has no distributable mass; it must be
      // handled like a dangling node (uniform redistribution), keeping the
      // rank vector finite with total ≈ 1.
      const adj: AdjacencyMap = new Map([
        ["a", ["b"]],
        ["b", ["a"]],
      ]);
      const { ranks } = pageRank(adj, { weights: new Map([["b", [0]]]) });
      const total = [...ranks.values()].reduce((sum, r) => sum + r, 0);
      expect(total).toBeCloseTo(1, 3);
      for (const v of ranks.values()) expect(Number.isFinite(v)).toBe(true);
    });
  });
});
