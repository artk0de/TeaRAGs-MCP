/**
 * Tarjan's strongly-connected-components algorithm.
 *
 * Returns multi-node cycles (size >= 2). Single-node SCCs (which form
 * an "SCC" only if they have a self-loop) are excluded — they're
 * either harmless or surfaced by other signals; only real circular
 * dependencies between distinct nodes are interesting.
 *
 * Iterative implementation: the recursive form would blow the JS call
 * stack on hub-shaped graphs with thousands of nodes. Manual stack
 * threading mirrors the classical pseudocode while staying safe at
 * scale. Complexity O(V + E).
 *
 * Pure function, no I/O. The caller (DuckDB adapter) feeds in the
 * adjacency map and persists the result.
 */

export type AdjacencyMap = Map<string, readonly string[]>;

export type Scc = readonly string[];

interface Frame {
  node: string;
  /** Index into successors[] — next neighbour to consider. */
  nextChild: number;
}

export function tarjanScc(adjacency: AdjacencyMap): Scc[] {
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: Scc[] = [];
  let nextIndex = 0;

  // Collect every node mentioned as a source — adjacency only stores
  // outgoing edges, so sinks (nodes that appear only as targets) need
  // to be added explicitly. Without this, a target-only node never
  // gets walked and any cycle it participates in via reverse edges is
  // missed. The current callers feed adjacency keyed on every node
  // that has outgoing edges, which is the only side we need for SCC
  // (an SCC requires every member to be both source and target).
  for (const root of adjacency.keys()) {
    if (indexOf.has(root)) continue;
    // Per-root iterative DFS frame stack.
    const frames: Frame[] = [{ node: root, nextChild: 0 }];
    indexOf.set(root, nextIndex);
    lowlink.set(root, nextIndex);
    nextIndex++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const successors = adjacency.get(frame.node) ?? [];
      if (frame.nextChild < successors.length) {
        const w = successors[frame.nextChild];
        frame.nextChild++;
        if (!indexOf.has(w)) {
          indexOf.set(w, nextIndex);
          lowlink.set(w, nextIndex);
          nextIndex++;
          stack.push(w);
          onStack.add(w);
          frames.push({ node: w, nextChild: 0 });
        } else if (onStack.has(w)) {
          const vLow = lowlink.get(frame.node) ?? Number.POSITIVE_INFINITY;
          const wIdx = indexOf.get(w) ?? Number.POSITIVE_INFINITY;
          lowlink.set(frame.node, Math.min(vLow, wIdx));
        }
      } else {
        // All successors of frame.node processed — pop and integrate
        // its lowlink into parent (if any).
        const v = frame.node;
        const vIdx = indexOf.get(v);
        const vLow = lowlink.get(v);
        if (vIdx !== undefined && vLow !== undefined && vIdx === vLow) {
          // Root of an SCC — pop until v itself.
          const component: string[] = [];
          while (true) {
            const w = stack.pop();
            if (w === undefined) break;
            onStack.delete(w);
            component.push(w);
            if (w === v) break;
          }
          // Multi-node only — single-node "SCCs" are noise.
          if (component.length >= 2) {
            result.push(component);
          }
        }
        frames.pop();
        if (frames.length > 0 && vLow !== undefined) {
          const parent = frames[frames.length - 1].node;
          const parentLow = lowlink.get(parent) ?? Number.POSITIVE_INFINITY;
          lowlink.set(parent, Math.min(parentLow, vLow));
        }
      }
    }
  }

  return result;
}
