import type { RelPath, SymbolId } from "../../../../../contracts/types/codegraph.js";

/** One in-project edge leaving a tree node, as the graph read handed it: the node on its far end. */
export interface CallTreeHop {
  symbolId: SymbolId;
  relPath: RelPath;
  edgeKind?: string;
  confidence?: number;
  /** `"model"` when a residual-resolution verdict produced the edge; absent means a static edge. */
  origin?: "model";
}

/** What one expanded node reaches: its in-project hops in answer order, and the sites that are not hops. */
export interface CallTreeExpansion {
  hops: CallTreeHop[];
  /** Call sites pinned to no in-project symbol (unresolved / external); collapsed into a count. */
  external: number;
}

/**
 * Reads the expansions of a whole BFS frontier in one graph query. A node with
 * nothing to expand may be absent from the map.
 */
export type CallTreeFrontierReader = (
  frontier: readonly SymbolId[],
) => Promise<ReadonlyMap<SymbolId, CallTreeExpansion>>;

/** One row of a call tree, in BFS order. */
export interface CallTreeNode extends CallTreeHop {
  /** Hops from the anchor: the anchor's own edges are depth 1. */
  depth: number;
  /** The node this edge leaves — the anchor for depth 1. Unambiguous: each symbol is expanded once. */
  parent: SymbolId;
  /** Expanded nodes only: their call sites that are not hops. Absent when zero or not expanded. */
  external?: number;
  /** The symbol already appeared earlier in BFS order; this row is a back-reference and is not expanded. */
  seen?: true;
}
