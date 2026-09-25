/**
 * Declared visibility for graph-tool responses (bd tea-rags-mcp-sqqkz) —
 * get_callers, get_callees and trace_path each run ONE batched read covering
 * every symbolId the response names, then attach the level per entry.
 *
 * Visibility is a DECORATION of a navigation answer, never part of it: a
 * lookup that fails for any reason yields the empty index, so the answer goes
 * out undecorated (every field omitted = unknown) instead of failing. The edge
 * list itself keeps its own error contract (`GraphFacade#withReadHandle`).
 */

import type {
  CalleeEdge,
  CallerEdge,
  DeclaredSymbolVisibility,
  GraphDbClient,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import { DeclaredVisibilityIndex } from "../../../infra/declared-visibility-index.js";
import type { DeclaredVisibilityField } from "../../public/dto/graph.js";

type VisibilityReader = Pick<GraphDbClient, "getSymbolVisibilities">;

export async function lookupDeclaredVisibility(
  graphDb: VisibilityReader,
  symbolIds: readonly SymbolId[],
): Promise<DeclaredVisibilityIndex> {
  const unique = [...new Set(symbolIds)];
  if (unique.length === 0) return DeclaredVisibilityIndex.EMPTY;
  try {
    return DeclaredVisibilityIndex.fromRows(await graphDb.getSymbolVisibilities(unique));
  } catch {
    return DeclaredVisibilityIndex.EMPTY;
  }
}

/**
 * Attach a declared visibility to a response entry — or return the entry
 * untouched when the level is unknown. The field is OMITTED, never `null`.
 */
export function withVisibility<T extends object>(
  entry: T,
  visibility: DeclaredSymbolVisibility | undefined,
): T & DeclaredVisibilityField {
  return visibility === undefined ? entry : { ...entry, visibility };
}

/**
 * Callers each carry the CALLER's level; `queried` carries the queried
 * symbol's own — present only when every definition of it agrees.
 */
export async function decorateCallers<E extends CallerEdge>(
  graphDb: VisibilityReader,
  symbolId: SymbolId,
  edges: readonly E[],
): Promise<{ queried: DeclaredVisibilityField; callers: (E & DeclaredVisibilityField)[] }> {
  const levels = await lookupDeclaredVisibility(graphDb, [symbolId, ...edges.map((e) => e.sourceSymbolId)]);
  return {
    queried: withVisibility({}, levels.agreedFor(symbolId)),
    callers: edges.map((e) => withVisibility(e, levels.at(e.sourceRelPath, e.sourceSymbolId))),
  };
}

/** Callees each carry the TARGET's level; a file-only edge (no target symbol) never does. */
export async function decorateCallees<E extends CalleeEdge>(
  graphDb: VisibilityReader,
  edges: readonly E[],
): Promise<(E & DeclaredVisibilityField)[]> {
  const levels = await lookupDeclaredVisibility(
    graphDb,
    edges.flatMap((e) => (e.targetSymbolId === null ? [] : [e.targetSymbolId])),
  );
  return edges.map((e) =>
    e.targetSymbolId === null ? e : withVisibility(e, levels.at(e.targetRelPath, e.targetSymbolId)),
  );
}
