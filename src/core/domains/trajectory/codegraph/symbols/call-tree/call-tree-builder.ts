import type { SymbolId } from "../../../../../contracts/types/codegraph.js";
import type { CallTreeFrontierReader, CallTreeHop, CallTreeNode } from "./types.js";

/**
 * Breadth-first call tree from `symbolId` (the anchor), `maxDepth` hops deep (bd
 * tea-rags-mcp-afdpc). Rows come out in BFS order: level by level, each
 * parent's hops in the order the read handed them. A symbol is expanded once —
 * the anchor counts as seen — and every later occurrence is a `seen` row that
 * is not expanded again, so a cycle or a shared helper costs one row per edge,
 * never a subtree. Each level below the first is ONE `readFrontier` call over
 * every node that level expands, never one read per node.
 */
export async function buildCallTree(
  symbolId: SymbolId,
  anchorHops: readonly CallTreeHop[],
  readFrontier: CallTreeFrontierReader,
  maxDepth: number,
): Promise<CallTreeNode[]> {
  const seen = new Set<SymbolId>([symbolId]);
  const nodes: CallTreeNode[] = [];
  let level = placeLevel(
    anchorHops.map((hop) => ({ hop, parent: symbolId })),
    1,
    seen,
    nodes,
  );
  for (let depth = 2; depth <= maxDepth && level.length > 0; depth++) {
    const expansions = await readFrontier(level.map((node) => node.symbolId));
    const next: { hop: CallTreeHop; parent: SymbolId }[] = [];
    for (const node of level) {
      const expansion = expansions.get(node.symbolId);
      if (!expansion) continue;
      if (expansion.external > 0) node.external = expansion.external;
      for (const hop of expansion.hops) next.push({ hop, parent: node.symbolId });
    }
    level = placeLevel(next, depth, seen, nodes);
  }
  return nodes;
}

/** Appends one level's rows; returns the rows of that level to expand next (first occurrences only). */
function placeLevel(
  edges: readonly { hop: CallTreeHop; parent: SymbolId }[],
  depth: number,
  seen: Set<SymbolId>,
  nodes: CallTreeNode[],
): CallTreeNode[] {
  const expandable: CallTreeNode[] = [];
  for (const { hop, parent } of edges) {
    const repeat = seen.has(hop.symbolId);
    const node: CallTreeNode = { ...hop, depth, parent, ...(repeat && { seen: true as const }) };
    nodes.push(node);
    if (repeat) continue;
    seen.add(hop.symbolId);
    expandable.push(node);
  }
  return expandable;
}
