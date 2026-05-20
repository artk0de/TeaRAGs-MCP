import { describe, expect, it } from "vitest";

import { tarjanScc, type AdjacencyMap } from "../../../../src/core/infra/graph/tarjan-scc.js";

describe("tarjanScc", () => {
  it("returns empty when no cycles exist (DAG)", () => {
    const adj: AdjacencyMap = new Map([
      ["a", ["b", "c"]],
      ["b", ["d"]],
      ["c", ["d"]],
      ["d", []],
    ]);
    expect(tarjanScc(adj)).toEqual([]);
  });

  it("returns a single 2-node SCC for A↔B", () => {
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const sccs = tarjanScc(adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].slice().sort()).toEqual(["a", "b"]);
  });

  it("returns a 3-node SCC for triangle A→B→C→A", () => {
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const sccs = tarjanScc(adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].slice().sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores single-node 'SCCs' (no self-loop discrimination needed)", () => {
    const adj: AdjacencyMap = new Map([
      ["solo", []],
      ["isolated", []],
    ]);
    expect(tarjanScc(adj)).toEqual([]);
  });

  it("returns multiple independent SCCs", () => {
    // Two disjoint cycles: a↔b and c↔d↔e (triangle)
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["e"]],
      ["e", ["c"]],
    ]);
    const sccs = tarjanScc(adj);
    expect(sccs).toHaveLength(2);
    const sorted = sccs.map((s) => s.slice().sort()).sort((x, y) => x.length - y.length);
    expect(sorted[0]).toEqual(["a", "b"]);
    expect(sorted[1]).toEqual(["c", "d", "e"]);
  });

  it("handles a node both inside an SCC and pointing outside it", () => {
    // a↔b is the only cycle; b also points to c (DAG tail).
    const adj: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", []],
    ]);
    const sccs = tarjanScc(adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].slice().sort()).toEqual(["a", "b"]);
  });

  it("iterative DFS survives deep linear chains without stack overflow", () => {
    // Long chain feeding into a 2-cycle at the end. Recursive Tarjan
    // would blow up on a few thousand levels; iterative must complete.
    const N = 5000;
    const adj = new Map<string, string[]>();
    for (let i = 0; i < N; i++) {
      adj.set(`n${i}`, [`n${i + 1}`]);
    }
    adj.set(`n${N}`, ["cycA"]);
    adj.set("cycA", ["cycB"]);
    adj.set("cycB", ["cycA"]);
    const sccs = tarjanScc(adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].slice().sort()).toEqual(["cycA", "cycB"]);
  });
});
