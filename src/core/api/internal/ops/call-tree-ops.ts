/**
 * Paging and the `depth > 1` call tree of get_callers / get_callees (bd tea-rags-mcp-afdpc).
 *
 * Every graph list pages one way: `offset` + `limit` over an order the read
 * fixes, and a `truncated` block only when rows remain past the window — the
 * MCP layer turns it into the continuation call. The tree is `buildCallTree`
 * over one bulk edge read per BFS level, filtered and collapsed exactly as the
 * one-hop answer is, then paged over its flattened BFS order; signatures are
 * read for the returned page only.
 */

import type { CalleeEdge, CallerEdge, EdgeOrigin, SymbolId } from "../../../contracts/types/codegraph.js";
import {
  buildCallTree,
  type CallTreeExpansion,
  type CallTreeHop,
  type CallTreeNode,
} from "../../../domains/trajectory/codegraph/symbols/index.js";
import {
  CALL_TREE_DEFAULT_LIMIT,
  type CallTreeRow,
  type GraphPageTruncation,
  type SymbolCallTreeResponse,
} from "../../public/dto/graph.js";

/** The reads a call tree takes, bound to the request's graph handle and collection. */
export interface CallTreeReads {
  readCalleesBulk: (symbolIds: readonly SymbolId[]) => Promise<Map<SymbolId, CalleeEdge[]>>;
  readCallersBulk: (symbolIds: readonly SymbolId[]) => Promise<Map<SymbolId, CallerEdge[]>>;
  /** One-line signatures by id; absent dep or a failed read leaves rows without one. */
  readSignatures?: (symbolIds: readonly SymbolId[]) => Promise<ReadonlyMap<SymbolId, string>>;
  /** The edge filter navigation answers apply (`isNavigationVisibleEdge`). */
  isVisible: (edge: { edgeKind?: string; confidence?: number }) => boolean;
}

export interface CallTreePageRequest {
  depth: number;
  limit?: number;
  offset?: number;
}

/** `rows[offset, offset + limit)` and, when rows remain past it, the cut. */
export function pageGraphRows<T>(
  rows: readonly T[],
  offset: number | undefined,
  limit: number,
): { rows: T[]; truncated?: GraphPageTruncation } {
  const start = offset ?? 0;
  const page = rows.slice(start, start + limit);
  const omitted = Math.max(0, rows.length - start - page.length);
  return omitted > 0 ? { rows: page, truncated: { returned: page.length, omitted } } : { rows: page };
}

/** The forward tree: `anchorEdges` = the queried symbol's own callee edges, as the one-hop read returned them. */
export async function readCalleeTree(
  symbolId: SymbolId,
  anchorEdges: readonly CalleeEdge[],
  reads: CallTreeReads,
  request: CallTreePageRequest,
): Promise<SymbolCallTreeResponse> {
  const first = calleeExpansion(anchorEdges, reads.isVisible);
  const nodes = await buildCallTree(
    symbolId,
    first.hops,
    async (frontier) => expansionsOf(await reads.readCalleesBulk(frontier), (e) => calleeExpansion(e, reads.isVisible)),
    request.depth,
  );
  return {
    ...(await pageTree(nodes, reads, request)),
    ...(first.external > 0 ? { unresolved: first.external } : {}),
  };
}

/** The reverse tree: `anchorEdges` = the queried symbol's own caller edges. */
export async function readCallerTree(
  symbolId: SymbolId,
  anchorEdges: readonly CallerEdge[],
  reads: CallTreeReads,
  request: CallTreePageRequest,
): Promise<SymbolCallTreeResponse> {
  const nodes = await buildCallTree(
    symbolId,
    callerExpansion(anchorEdges, reads.isVisible).hops,
    async (frontier) => expansionsOf(await reads.readCallersBulk(frontier), (e) => callerExpansion(e, reads.isVisible)),
    request.depth,
  );
  return pageTree(nodes, reads, request);
}

async function pageTree(
  nodes: readonly CallTreeNode[],
  reads: CallTreeReads,
  request: CallTreePageRequest,
): Promise<{ tree: CallTreeRow[]; truncated?: GraphPageTruncation }> {
  const page = pageGraphRows(nodes, request.offset, request.limit ?? CALL_TREE_DEFAULT_LIMIT);
  const signatures = await readSignaturesOf(page.rows, reads);
  // A back-reference row points at the row that already carries the signature.
  const tree = page.rows.map((node) => toRow(node, node.seen ? undefined : signatures.get(node.symbolId)));
  return page.truncated ? { tree, truncated: page.truncated } : { tree };
}

async function readSignaturesOf(
  nodes: readonly CallTreeNode[],
  reads: CallTreeReads,
): Promise<ReadonlyMap<SymbolId, string>> {
  if (!reads.readSignatures || nodes.length === 0) return new Map();
  // A signature decorates a row; an index read that fails leaves the row without one, never the answer.
  const ids = [...new Set(nodes.filter((n) => !n.seen).map((n) => n.symbolId))];
  if (ids.length === 0) return new Map();
  return reads.readSignatures(ids).catch(() => new Map());
}

/** Fixed key order, keys without a value left out — the column table drops what no row carries. */
function toRow(node: CallTreeNode, signature: string | undefined): CallTreeRow {
  return {
    depth: node.depth,
    parent: node.parent,
    symbolId: node.symbolId,
    relPath: node.relPath,
    ...(node.edgeKind !== undefined && { edgeKind: node.edgeKind }),
    ...(node.confidence !== undefined && { confidence: node.confidence }),
    ...(node.origin !== undefined && { origin: node.origin }),
    ...(node.external !== undefined && { external: node.external }),
    ...(node.seen && { seen: true as const }),
    ...(signature !== undefined && { signature }),
  };
}

function expansionsOf<E>(
  bySymbol: ReadonlyMap<SymbolId, E[]>,
  expand: (edges: readonly E[]) => CallTreeExpansion,
): Map<SymbolId, CallTreeExpansion> {
  return new Map([...bySymbol].map(([symbolId, edges]) => [symbolId, expand(edges)]));
}

/** Visible callee edges, one hop per target symbol (first site wins, as the one-hop answer collapses them). */
function calleeExpansion(edges: readonly CalleeEdge[], isVisible: CallTreeReads["isVisible"]): CallTreeExpansion {
  const visible = edges.filter(isVisible);
  const hops = new Map<SymbolId, CallTreeHop>();
  let external = 0;
  for (const edge of visible) {
    if (edge.targetSymbolId === null) external += 1;
    else if (!hops.has(edge.targetSymbolId)) {
      hops.set(edge.targetSymbolId, hopOf(edge.targetSymbolId, edge.targetRelPath, edge));
    }
  }
  return { hops: [...hops.values()], external };
}

/** Visible caller edges, one hop per source symbol. */
function callerExpansion(edges: readonly CallerEdge[], isVisible: CallTreeReads["isVisible"]): CallTreeExpansion {
  const hops = new Map<SymbolId, CallTreeHop>();
  for (const edge of edges.filter(isVisible)) {
    if (!hops.has(edge.sourceSymbolId)) {
      hops.set(edge.sourceSymbolId, hopOf(edge.sourceSymbolId, edge.sourceRelPath, edge));
    }
  }
  return { hops: [...hops.values()], external: 0 };
}

function hopOf(
  symbolId: SymbolId,
  relPath: string,
  edge: { edgeKind?: string; confidence?: number; origin?: EdgeOrigin },
): CallTreeHop {
  return {
    symbolId,
    relPath,
    ...(edge.edgeKind !== undefined && { edgeKind: edge.edgeKind }),
    ...(edge.confidence !== undefined && { confidence: edge.confidence }),
    ...(edge.origin === "model" && { origin: "model" as const }),
  };
}
