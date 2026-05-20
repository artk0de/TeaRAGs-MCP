/**
 * Iterative PageRank over a directed graph.
 *
 * Formula:
 *   PR(v) = (1 - d) / N + d * sum over u in incoming(v): PR(u) / outDegree(u)
 *
 * - damping factor `d` = 0.85 (Google's original)
 * - convergence ε = 1e-6 (L1 norm of rank delta)
 * - max iterations = 50 (caps cost; if not converged, return the last vector
 *   — degradation is graceful, ranks are still in the right ballpark)
 *
 * Dangling nodes (zero out-degree) leak rank if untreated — Brin & Page
 * fix this by distributing each dangling node's rank uniformly to every
 * other node every iteration. That's what `danglingMass` does below.
 *
 * Pure function, no I/O. Adjacency is keyed on source node; the caller
 * is responsible for materialising it. Nodes that appear only as targets
 * (sinks) are inferred from the adjacency value lists.
 *
 * Complexity: O(K · (V + E)) where K = converged iteration count, V =
 * unique node count, E = edge count.
 */

export type AdjacencyMap = Map<string, readonly string[]>;

export interface PageRankOptions {
  damping?: number;
  epsilon?: number;
  maxIterations?: number;
}

export interface PageRankResult {
  ranks: Map<string, number>;
  iterations: number;
  converged: boolean;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_EPSILON = 1e-6;
const DEFAULT_MAX_ITER = 50;

export function pageRank(adjacency: AdjacencyMap, options: PageRankOptions = {}): PageRankResult {
  const damping = options.damping ?? DEFAULT_DAMPING;
  const epsilon = options.epsilon ?? DEFAULT_EPSILON;
  const maxIter = options.maxIterations ?? DEFAULT_MAX_ITER;

  // Collect every node mentioned as source OR target. The adjacency
  // map only enumerates outgoing-edge sources; targets that never
  // appear as keys are sinks and must be added explicitly so they
  // receive their share of (1-d)/N + dangling redistribution.
  const nodes = new Set<string>();
  const inEdges = new Map<string, string[]>();
  const outDegree = new Map<string, number>();
  for (const [source, targets] of adjacency) {
    nodes.add(source);
    outDegree.set(source, targets.length);
    for (const target of targets) {
      nodes.add(target);
      const list = inEdges.get(target);
      if (list) list.push(source);
      else inEdges.set(target, [source]);
    }
  }
  if (nodes.size === 0) {
    return { ranks: new Map(), iterations: 0, converged: true };
  }

  const N = nodes.size;
  const initial = 1 / N;
  let current = new Map<string, number>();
  for (const node of nodes) current.set(node, initial);

  const teleport = (1 - damping) / N;

  for (let iter = 1; iter <= maxIter; iter++) {
    // Distribute rank from dangling nodes (zero outDegree) uniformly
    // across every node. Without this, rank "leaks out" of the system
    // each iteration and total mass drops below 1 — the resulting
    // ranks are still ordinally meaningful but no longer normalised.
    let danglingMass = 0;
    for (const node of nodes) {
      const deg = outDegree.get(node) ?? 0;
      if (deg === 0) danglingMass += current.get(node) ?? 0;
    }
    const danglingShare = (damping * danglingMass) / N;

    const next = new Map<string, number>();
    let delta = 0;
    for (const node of nodes) {
      let incoming = 0;
      const sources = inEdges.get(node) ?? [];
      for (const source of sources) {
        const deg = outDegree.get(source) ?? 0;
        if (deg === 0) continue; // dangling; handled via danglingShare
        incoming += (current.get(source) ?? 0) / deg;
      }
      const rank = teleport + danglingShare + damping * incoming;
      next.set(node, rank);
      delta += Math.abs(rank - (current.get(node) ?? 0));
    }

    current = next;
    if (delta < epsilon) {
      return { ranks: current, iterations: iter, converged: true };
    }
  }

  return { ranks: current, iterations: maxIter, converged: false };
}
