/**
 * Transitive visibility of every node in a directed graph (bd
 * tea-rags-mcp-r8hme.49): fan-out = nodes it reaches, fan-in = nodes reaching
 * it, both counting the node itself (the reflexive closure MacCormack's
 * propagation cost and Baldwin–MacCormack's visibility measures read).
 *
 * A per-node BFS is O(V·E) — unaffordable on a graph of tens of thousands of
 * files. Instead:
 *  1. condense every strongly-connected component to one node (Tarjan, O(V+E))
 *     — members of an SCC reach exactly the same set, so one row serves all;
 *  2. walk the condensed DAG in reverse topological order, each row the OR of
 *     its successors' rows plus its own bit; counts weight each bit by its
 *     SCC's size;
 *  3. bound memory by processing the condensed columns in blocks: one pass
 *     holds C rows of at most `maxBitsetWords` 32-bit words, so memory is
 *     O(C · maxBitsetWords) whatever C is, and time O((C + E_c) · C / 32) word
 *     operations per direction (E_c = distinct condensed edges).
 *
 * The result is exact — no depth cap. A cap would make the closure density a
 * different quantity from MacCormack's, and the bitsets make the exact one
 * affordable. Fan-in runs the same pass over the reversed DAG.
 */
import { tarjanScc, type AdjacencyMap } from "./tarjan-scc.js";

/** Default per-pass bitset budget: 4M words = 16 MiB of rows. */
export const DEFAULT_VISIBILITY_BITSET_WORDS = 1 << 22;

export interface TransitiveVisibilityOptions {
  /** Upper bound on bitset words held at once across all rows (memory = 4 bytes × this). */
  maxBitsetWords?: number;
}

export interface TransitiveVisibility {
  /** Nodes each node reaches, itself included. */
  fanOut: Map<string, number>;
  /** Nodes reaching each node, itself included. */
  fanIn: Map<string, number>;
  /** Σ fanOut = Σ fanIn — the number of set cells in the reflexive closure. */
  reachablePairCount: number;
  /** Size of the strongly-connected component each node belongs to (1 for an acyclic node). */
  sccSize: Map<string, number>;
  /** Largest strongly-connected component (1 when the graph is acyclic, 0 when empty). */
  largestSccSize: number;
  /** Nodes of the condensed DAG. */
  condensedNodeCount: number;
}

/** A DAG over condensed ids, `successors[c]` deduplicated, `sizes[c]` = member count. */
interface CondensedDag {
  sizes: number[];
  successors: number[][];
}

/**
 * Visibility of every node in `adjacency`. Every node must be a key (a sink
 * with `[]`); a target that is not a key is ignored.
 */
export function transitiveVisibility(
  adjacency: AdjacencyMap,
  options: TransitiveVisibilityOptions = {},
): TransitiveVisibility {
  const maxBitsetWords = options.maxBitsetWords ?? DEFAULT_VISIBILITY_BITSET_WORDS;
  const { componentOf, dag } = condense(adjacency);
  const condensedCount = dag.sizes.length;
  const order = topologicalOrder(dag.successors);
  const predecessors: number[][] = dag.successors.map(() => []);
  dag.successors.forEach((targets, source) => {
    for (const target of targets) predecessors[target].push(source);
  });
  // Reverse topological order (sinks first) for reach; topological order is
  // the reversed DAG's reverse topological order.
  const outByCondensed = weightedReach(dag.sizes, dag.successors, [...order].reverse(), maxBitsetWords);
  const inByCondensed = weightedReach(dag.sizes, predecessors, order, maxBitsetWords);

  const fanOut = new Map<string, number>();
  const fanIn = new Map<string, number>();
  const sccSize = new Map<string, number>();
  let reachablePairCount = 0;
  for (const [node, condensed] of componentOf) {
    fanOut.set(node, outByCondensed[condensed]);
    fanIn.set(node, inByCondensed[condensed]);
    sccSize.set(node, dag.sizes[condensed]);
    reachablePairCount += outByCondensed[condensed];
  }
  return {
    fanOut,
    fanIn,
    sccSize,
    reachablePairCount,
    largestSccSize: dag.sizes.reduce((max, size) => Math.max(max, size), 0),
    condensedNodeCount: condensedCount,
  };
}

function condense(adjacency: AdjacencyMap): { componentOf: Map<string, number>; dag: CondensedDag } {
  const componentOf = new Map<string, number>();
  const sizes: number[] = [];
  for (const scc of tarjanScc(adjacency)) {
    const id = sizes.length;
    sizes.push(scc.length);
    for (const node of scc) componentOf.set(node, id);
  }
  // Tarjan reports only multi-node SCCs; every other node is its own one.
  for (const node of adjacency.keys()) {
    if (!componentOf.has(node)) {
      componentOf.set(node, sizes.length);
      sizes.push(1);
    }
  }
  const successorSets = sizes.map(() => new Set<number>());
  for (const [source, targets] of adjacency) {
    const from = componentOf.get(source) as number;
    for (const target of targets) {
      const to = componentOf.get(target);
      if (to !== undefined && to !== from) successorSets[from].add(to);
    }
  }
  return { componentOf, dag: { sizes, successors: successorSets.map((s) => [...s]) } };
}

/** Kahn's algorithm over an acyclic successor list. */
function topologicalOrder(successors: readonly number[][]): number[] {
  const indegree = new Array<number>(successors.length).fill(0);
  for (const targets of successors) for (const target of targets) indegree[target]++;
  const order: number[] = [];
  for (let node = 0; node < successors.length; node++) if (indegree[node] === 0) order.push(node);
  // The array iterator reads `length` per step, so it visits nodes pushed during the walk.
  for (const node of order) {
    for (const target of successors[node]) {
      indegree[target]--;
      if (indegree[target] === 0) order.push(target);
    }
  }
  return order;
}

/**
 * Σ size over every condensed node each node reaches through `successors`
 * (itself included). `sinkFirst` must list every node after all its
 * successors. Columns are processed in blocks of `32 · wordsPerRow` so at most
 * `count · wordsPerRow ≤ maxBitsetWords` words are live.
 */
function weightedReach(
  sizes: readonly number[],
  successors: readonly number[][],
  sinkFirst: readonly number[],
  maxBitsetWords: number,
): number[] {
  const count = sizes.length;
  const reach = new Array<number>(count).fill(0);
  if (count === 0) return reach;
  const wordsPerRow = Math.max(1, Math.min(Math.ceil(count / 32), Math.floor(maxBitsetWords / count)));
  const blockBits = wordsPerRow * 32;
  const rows = new Uint32Array(count * wordsPerRow);
  for (let blockStart = 0; blockStart < count; blockStart += blockBits) {
    const blockEnd = Math.min(count, blockStart + blockBits);
    // Members of a multi-node SCC in this block weigh more than one bit.
    const heavy: number[] = [];
    for (let c = blockStart; c < blockEnd; c++) if (sizes[c] > 1) heavy.push(c);
    rows.fill(0);
    for (const node of sinkFirst) {
      const base = node * wordsPerRow;
      if (node >= blockStart && node < blockEnd) {
        const bit = node - blockStart;
        rows[base + (bit >>> 5)] |= 1 << (bit & 31);
      }
      for (const next of successors[node]) {
        const nextBase = next * wordsPerRow;
        for (let w = 0; w < wordsPerRow; w++) rows[base + w] |= rows[nextBase + w];
      }
      let total = 0;
      for (let w = 0; w < wordsPerRow; w++) total += popcount32(rows[base + w]);
      for (const c of heavy) {
        const bit = c - blockStart;
        if ((rows[base + (bit >>> 5)] >>> (bit & 31)) & 1) total += sizes[c] - 1;
      }
      reach[node] += total;
    }
  }
  return reach;
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}
