/**
 * Transitive visibility over an SCC-condensed DAG (bd tea-rags-mcp-r8hme.49):
 * per node, visibility fan-out = nodes it reaches (itself included), fan-in =
 * nodes reaching it. Every assertion here is against a naive per-node BFS —
 * the condensation and the chunked bitsets must not change a single count.
 */
import { describe, expect, it } from "vitest";

import type { AdjacencyMap } from "../../../../src/core/infra/graph/tarjan-scc.js";
import { transitiveVisibility } from "../../../../src/core/infra/graph/transitive-visibility.js";

function naiveVisibility(adjacency: AdjacencyMap) {
  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>([...adjacency.keys()].map((n) => [n, 0]));
  for (const start of adjacency.keys()) {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length > 0) {
      const node = queue.shift() as string;
      for (const next of adjacency.get(node) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    fanOut.set(start, seen.size);
    for (const reached of seen) fanIn.set(reached, (fanIn.get(reached) ?? 0) + 1);
  }
  let reachablePairCount = 0;
  for (const value of fanOut.values()) reachablePairCount += value;
  return { fanIn, fanOut, reachablePairCount };
}

/** Mulberry32 — a seeded PRNG so the random graph is the same every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGraph(seed: number, nodeCount: number, edgeCount: number): AdjacencyMap {
  const random = seededRandom(seed);
  const out = new Map<string, string[]>();
  for (let i = 0; i < nodeCount; i++) out.set(`n${i}`, []);
  for (let i = 0; i < edgeCount; i++) {
    const source = Math.floor(random() * nodeCount);
    const target = Math.floor(random() * nodeCount);
    out.get(`n${source}`)?.push(`n${target}`);
  }
  return out;
}

describe("transitiveVisibility", () => {
  it("counts a chain's reach with every node reaching itself", () => {
    const adjacency: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
    ]);
    const result = transitiveVisibility(adjacency);
    expect(Object.fromEntries(result.fanOut)).toEqual({ a: 3, b: 2, c: 1 });
    expect(Object.fromEntries(result.fanIn)).toEqual({ a: 1, b: 2, c: 3 });
    expect(result.reachablePairCount).toBe(6);
    expect(result.largestSccSize).toBe(1);
    expect(result.condensedNodeCount).toBe(3);
  });

  it("gives every member of a cycle the cycle's whole reach, equal to naive BFS", () => {
    const adjacency: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", ["d"]],
      ["d", ["c"]],
      ["e", ["a", "e"]],
    ]);
    const result = transitiveVisibility(adjacency);
    const naive = naiveVisibility(adjacency);
    expect(result.fanOut).toEqual(naive.fanOut);
    expect(result.fanIn).toEqual(naive.fanIn);
    expect(result.reachablePairCount).toBe(naive.reachablePairCount);
    expect(result.fanOut.get("a")).toBe(4);
    expect(result.largestSccSize).toBe(2);
    expect(result.condensedNodeCount).toBe(3);
  });

  it("reports each node's strongly-connected component size, 1 for an acyclic node", () => {
    const adjacency: AdjacencyMap = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", ["d"]],
      ["d", ["e"]],
      ["e", ["c"]],
      ["f", ["f"]],
    ]);
    const result = transitiveVisibility(adjacency);
    expect(Object.fromEntries(result.sccSize)).toEqual({ a: 2, b: 2, c: 3, d: 3, e: 3, f: 1 });
  });

  it("matches naive BFS on a seeded random graph, across several bitset blocks", () => {
    const adjacency = randomGraph(49, 120, 170);
    const naive = naiveVisibility(adjacency);
    // One 32-bit word per row forces the condensed nodes through many blocks.
    for (const maxBitsetWords of [1, 3, undefined]) {
      const result = transitiveVisibility(adjacency, maxBitsetWords === undefined ? {} : { maxBitsetWords });
      expect(result.fanOut).toEqual(naive.fanOut);
      expect(result.fanIn).toEqual(naive.fanIn);
      expect(result.reachablePairCount).toBe(naive.reachablePairCount);
    }
  });

  it("returns empty visibility for an empty graph", () => {
    const result = transitiveVisibility(new Map());
    expect(result.fanOut.size).toBe(0);
    expect(result.reachablePairCount).toBe(0);
    expect(result.largestSccSize).toBe(0);
  });
});
