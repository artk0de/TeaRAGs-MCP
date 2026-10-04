import { tarjanScc, type Scc } from "../../../../../infra/graph/tarjan-scc.js";

/**
 * Graph primitives shared by every layering consumer (bd tea-rags-mcp-r8hme.22
 * detector, the r8hme.26 layer map, the r8hme.30 domain partition): SCC knots,
 * longest-path levels and the greedy weighted feedback arc set, all over plain
 * {source, target, callWeight} edges so any node mapping can feed them.
 */

/** A directed edge with the weight the cut or the ranking pays. */
export interface SimpleEdge {
  source: string;
  target: string;
  callWeight: number;
}

/** Condensation node name for SCC #index — NUL keeps it disjoint from every path. */
export function knotNodeName(index: number): string {
  return `\u0000knot${index}`;
}

/** Adjacency (both directions) over edges whose endpoints are already node names. */
export function adjacencyMaps(edges: readonly SimpleEdge[]): {
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
} {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const link = (map: Map<string, string[]>, from: string, to: string) => {
    if (from === to) return;
    const targets = map.get(from) ?? [];
    if (!targets.includes(to)) targets.push(to);
    map.set(from, targets);
  };
  for (const edge of edges) {
    link(outgoing, edge.source, edge.target);
    link(incoming, edge.target, edge.source);
  }
  return { outgoing, incoming };
}

/** Multi-node SCCs of a plain edge list. */
export function sccKnots(edges: readonly SimpleEdge[]): readonly Scc[] {
  const adjacency = new Map<string, readonly string[]>();
  for (const [node, targets] of adjacencyMaps(edges).outgoing) adjacency.set(node, targets);
  return tarjanScc(adjacency);
}

/**
 * Longest paths over a DAG-shaped adjacency: `forward` measures from the sinks
 * (level: 0 = foundation), `backward` from the roots (depth: 0 = nothing
 * depends on it). The pre-set memo only breaks a hypothetical cycle.
 */
export function longestPaths(nodes: readonly string[], next: Map<string, string[]>): Map<string, number> {
  const memo = new Map<string, number>();
  const resolve = (node: string): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    memo.set(node, 0);
    const successors = next.get(node) ?? [];
    const value = successors.length === 0 ? 0 : 1 + Math.max(...successors.map(resolve));
    memo.set(node, value);
    return value;
  };
  nodes.forEach(resolve);
  return memo;
}

/** Distinct level count, 0-based; 0 when the graph holds no edge at all. */
export function levelCountOf(hasEdges: boolean, maxLevel: number): number {
  return hasEdges ? maxLevel + 1 : 0;
}

/**
 * Eades–Lin–Smyth over one knot's internal edges, weighted by call weight:
 * peel sources to the sequence's left block and sinks to its right block, else
 * remove the vertex with the largest weighted out-degree minus in-degree. The
 * feedback arc set is every edge pointing from later to earlier in the final
 * sequence — removing it leaves the sequence a topological order. Ties break
 * by path, so the cut is deterministic.
 */
export function weightedFeedbackArcSet(
  internal: readonly SimpleEdge[],
): { source: string; target: string; callWeight: number }[] {
  const position = new Map<string, number>();
  const remaining = new Set(internal.flatMap((edge) => [edge.source, edge.target]));
  // Sources collect in `front` in peel order and stay that way — the left
  // block of the canonical sequence. Sinks and max-delta picks append to
  // `back` in removal order; prepending them to the canonical right block is
  // the same list read backwards, so `back` reverses once at the end (bd
  // tea-rags-mcp-89k7k.12: the single list here took sources unshifted and
  // sinks appended — the two reversals swapped, which cut edges of a pure
  // source-chain DAG). Same canonical assembly as `eadesLinSmyth` in
  // layering.ts, which fixed this first (bd tea-rags-mcp-r8hme.42).
  const front: string[] = [];
  const back: string[] = [];
  const liveOut = (node: string) => internal.some((e) => e.source === node && remaining.has(e.target));
  const liveIn = (node: string) => internal.some((e) => e.target === node && remaining.has(e.source));
  const weightDelta = (node: string) => {
    let outWeight = 0;
    let inWeight = 0;
    for (const edge of internal) {
      if (!remaining.has(edge.source) || !remaining.has(edge.target)) continue;
      if (edge.source === node) outWeight += edge.callWeight;
      if (edge.target === node) inWeight += edge.callWeight;
    }
    return outWeight - inWeight;
  };

  while (remaining.size > 0) {
    let moved = true;
    while (moved && remaining.size > 0) {
      moved = false;
      for (const node of [...remaining].sort(compareCodePoints)) {
        if (liveOut(node) && liveIn(node)) continue;
        (liveOut(node) ? front : back).push(node);
        remaining.delete(node);
        moved = true;
      }
    }
    if (remaining.size === 0) break;
    let best: string | undefined;
    let bestDelta = Number.NEGATIVE_INFINITY;
    for (const node of [...remaining].sort(compareCodePoints)) {
      const delta = weightDelta(node);
      if (delta > bestDelta) {
        bestDelta = delta;
        best = node;
      }
    }
    if (best === undefined) break;
    remaining.delete(best);
    back.push(best);
  }
  [...front, ...back.reverse()].forEach((node, index) => position.set(node, index));

  return internal
    .filter((edge) => (position.get(edge.source) ?? 0) > (position.get(edge.target) ?? 0))
    .map((edge) => ({ source: edge.source, target: edge.target, callWeight: edge.callWeight }))
    .sort(
      (a, b) =>
        b.callWeight - a.callWeight || compareCodePoints(a.source, b.source) || compareCodePoints(a.target, b.target),
    );
}

/** Locale-independent, so the order is the same on every machine. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Condense the knots, then measure: level (longest path from the sinks, 0 =
 * foundation) and depth (from the roots, 0 = nothing depends on it) per node,
 * with knot members sharing their knot's position. Levels of cyclic raw graphs
 * are meaningless — the condensation is the honest measure.
 */
export function condensedPositions(edges: readonly SimpleEdge[]): {
  levelOf: (node: string) => number;
  depthOf: (node: string) => number;
  knotOf: Map<string, number>;
  knotCount: number;
} {
  const sccs = sccKnots(edges);
  const knotOf = new Map<string, number>();
  sccs.forEach((members, index) => {
    members.forEach((member) => knotOf.set(member, index));
  });
  const nodeName = (node: string) => {
    const knot = knotOf.get(node);
    return knot === undefined ? node : knotNodeName(knot);
  };
  const condensed = edges.map((edge) => ({ ...edge, source: nodeName(edge.source), target: nodeName(edge.target) }));
  const maps = adjacencyMaps(condensed);
  const condensedNodes = [
    ...new Set([...maps.outgoing.keys(), ...maps.incoming.keys(), ...sccs.map((_, index) => knotNodeName(index))]),
  ];
  const level = longestPaths(condensedNodes, maps.outgoing);
  const depth = longestPaths(condensedNodes, maps.incoming);
  return {
    levelOf: (node) => level.get(nodeName(node)) ?? 0,
    depthOf: (node) => depth.get(nodeName(node)) ?? 0,
    knotOf,
    knotCount: sccs.length,
  };
}
