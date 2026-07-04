/**
 * Iterative PageRank over a directed graph, with optional per-edge weights.
 *
 * Formula (weighted; every weight defaults to 1, which degenerates to the
 * classic uniform split):
 *   PR(v) = (1 - d) / N + d * sum over u in incoming(v): PR(u) * w(u→v) / W_out(u)
 * where W_out(u) is the sum of u's outgoing edge weights (== outDegree(u)
 * when unweighted).
 *
 * - damping factor `d` = 0.85 (Google's original)
 * - convergence ε = 1e-6 (L1 norm of rank delta)
 * - max iterations = 50 (caps cost; if not converged, return the last vector
 *   — degradation is graceful, ranks are still in the right ballpark)
 *
 * Weights exist for confidence-weighted call graphs (bd tea-rags-mcp-s5ato):
 * a dynamic dispatch site fanning out to m candidate targets at confidence
 * 1/m must distribute ONE call site's worth of rank across the fan, not m —
 * otherwise every fan-out target inflates into a fake hub.
 *
 * Dangling nodes (zero out-weight) leak rank if untreated — Brin & Page
 * fix this by distributing each dangling node's rank uniformly to every
 * other node every iteration. That's what `danglingMass` does below. A
 * source whose edges all weigh 0 is treated as dangling too (no division
 * by zero).
 *
 * Pure function, no I/O. Adjacency is keyed on source node; the caller
 * is responsible for materialising it. Nodes that appear only as targets
 * (sinks) are inferred from the adjacency value lists.
 *
 * Complexity: O(K · (V + E)) where K = converged iteration count, V =
 * unique node count, E = edge count.
 */

export type AdjacencyMap = Map<string, readonly string[]>;

/**
 * Per-source edge weights, index-aligned with the `AdjacencyMap` target
 * lists: `weights.get(source)[i]` weighs the edge `source → targets[i]`.
 * A missing source entry or missing index defaults that edge's weight to 1,
 * so partially-weighted graphs stay backward compatible.
 */
export type AdjacencyWeightMap = ReadonlyMap<string, readonly number[]>;

export interface PageRankOptions {
  damping?: number;
  epsilon?: number;
  maxIterations?: number;
  /** Optional per-edge weights. Absent → every edge weighs 1 (classic PageRank). */
  weights?: AdjacencyWeightMap;
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
  const { weights } = options;

  // Collect every node mentioned as source OR target. The adjacency
  // map only enumerates outgoing-edge sources; targets that never
  // appear as keys are sinks and must be added explicitly so they
  // receive their share of (1-d)/N + dangling redistribution.
  // In-edges are stored as two index-aligned arrays per target (sources +
  // weights) rather than tuple objects — the method graph is the daemon's
  // multi-GB hot path, so per-edge allocations matter.
  const nodes = new Set<string>();
  const inSources = new Map<string, string[]>();
  const inWeights = new Map<string, number[]>();
  const outWeight = new Map<string, number>();
  for (const [source, targets] of adjacency) {
    nodes.add(source);
    const sourceWeights = weights?.get(source);
    let total = 0;
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      const w = sourceWeights?.[i] ?? 1;
      total += w;
      nodes.add(target);
      const sList = inSources.get(target);
      const wList = inWeights.get(target);
      if (sList && wList) {
        sList.push(source);
        wList.push(w);
      } else {
        inSources.set(target, [source]);
        inWeights.set(target, [w]);
      }
    }
    outWeight.set(source, total);
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
    // Distribute rank from dangling nodes (zero out-weight) uniformly
    // across every node. Without this, rank "leaks out" of the system
    // each iteration and total mass drops below 1 — the resulting
    // ranks are still ordinally meaningful but no longer normalised.
    let danglingMass = 0;
    for (const node of nodes) {
      const w = outWeight.get(node) ?? 0;
      if (w === 0) danglingMass += current.get(node) ?? 0;
    }
    const danglingShare = (damping * danglingMass) / N;

    const next = new Map<string, number>();
    let delta = 0;
    for (const node of nodes) {
      let incoming = 0;
      const sources = inSources.get(node);
      if (sources) {
        const ws = inWeights.get(node) ?? [];
        for (let i = 0; i < sources.length; i++) {
          const source = sources[i];
          const totalOut = outWeight.get(source) ?? 0;
          if (totalOut === 0) continue; // dangling; handled via danglingShare
          incoming += ((current.get(source) ?? 0) * (ws[i] ?? 1)) / totalOut;
        }
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
