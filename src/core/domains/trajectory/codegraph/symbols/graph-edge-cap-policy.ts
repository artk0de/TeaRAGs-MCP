/**
 * The per-file edge cap of pass-2, stated as a policy over EVERY `GraphEdges`
 * kind (bd tea-rags-mcp-89k7k.35.17).
 *
 * The cap exists for one failure: a minified JS/TS bundle (Vite/Nuxt/Webpack
 * output that should live behind .gitignore but sometimes does not) produces
 * tens of thousands of edges in one file, and DuckDB blows past its
 * memory_limit committing a single transaction with that many INSERTs. Cap
 * chosen by inspection of the ugnest failure (a file with 96k method edges
 * OOM'd at 1.8 GB). Dropping such a file's edges is safe — a minified bundle
 * has no resolvable cross-file graph semantics — and the file still gets its
 * row, so the incremental repair diff does not re-list it (bd
 * tea-rags-mcp-ihq7y).
 *
 * Why a policy rather than a sum written by hand: the cap used to read
 * `fileEdges.length + methodEdges.length`, so a kind added to `GraphEdges`
 * later was neither counted nor consciously exempted — it was simply not
 * looked at. {@link GRAPH_EDGE_CAP_POLICY} is checked against `keyof
 * GraphEdges`, so a new kind fails the type check until someone decides which
 * side of the cap it sits on.
 */

import type { GraphEdges } from "../../../../contracts/types/codegraph.js";

/** Max counted edges one file may carry into a pass-2 upsert. */
export const MAX_EDGES_PER_FILE = 10000;

/** Every member of {@link GraphEdges} — the kinds the cap policy must classify. */
export type GraphEdgeKind = keyof GraphEdges;

/**
 * `counted` — the kind's rows add to the file's total against
 * {@link MAX_EDGES_PER_FILE}; it must be a required list — its `length` is
 * read, so classifying a record or an optional member `counted` fails the type
 * check in {@link countCappedGraphEdges} until the count is taught its shape.
 * `exempt` — the kind does not count, for the reason written beside it.
 *
 * Over the cap the file loses EVERY kind, counted or exempt: the row lands
 * with no edges at all ({@link pathologicalFileGraphEdges}), never a partial
 * slice.
 */
export type GraphEdgeCapRole = "counted" | "exempt";

/** A cap policy for the kind union `K` — total over `K` by construction. */
export type GraphEdgeCapPolicy<K extends PropertyKey = GraphEdgeKind> = Readonly<Record<K, GraphEdgeCapRole>>;

/**
 * The classification. Declaration order is the order the counted kinds are
 * reported in the over-cap debug line.
 */
export const GRAPH_EDGE_CAP_POLICY = {
  fileEdges: "counted",
  methodEdges: "counted",
  // Mirrored into `fileEdges` since bd tea-rags-mcp-89k7k.31 — counting the
  // dedicated list as well would charge each type-only edge twice.
  typeOnlyFileEdges: "exempt",
  // One row per declared superclass/mixin: bounded by the file's class
  // declarations, not by its call sites — never the minified-bundle shape.
  inheritance: "exempt",
  // Already the aggregate that REPLACES an over-cap fan-out's m edges with one
  // record (bd tea-rags-mcp-f2jsb / j0pki).
  ambiguousFanouts: "exempt",
  // A single per-file record, not a list of edges.
  pass1Aggregates: "exempt",
  // One row per hierarchy type the file's resolution read, bounded by the
  // project's type names rather than by the file's size.
  hierarchyDependencies: "exempt",
} as const satisfies GraphEdgeCapPolicy;

/** The kinds {@link GRAPH_EDGE_CAP_POLICY} counts against the cap. */
export type CountedGraphEdgeKind = {
  [K in GraphEdgeKind]: (typeof GRAPH_EDGE_CAP_POLICY)[K] extends "counted" ? K : never;
}[GraphEdgeKind];

const COUNTED_GRAPH_EDGE_KINDS: readonly CountedGraphEdgeKind[] = (
  Object.keys(GRAPH_EDGE_CAP_POLICY) as GraphEdgeKind[]
).filter((kind): kind is CountedGraphEdgeKind => GRAPH_EDGE_CAP_POLICY[kind] === "counted");

/** Per counted kind, the number of rows `edges` carries — in policy order. */
export function countedGraphEdgesByKind(edges: GraphEdges): Record<CountedGraphEdgeKind, number> {
  const counts = {} as Record<CountedGraphEdgeKind, number>;
  for (const kind of COUNTED_GRAPH_EDGE_KINDS) counts[kind] = edges[kind].length;
  return counts;
}

/** The total the cap compares against {@link MAX_EDGES_PER_FILE}. */
export function countCappedGraphEdges(edges: GraphEdges): number {
  let total = 0;
  for (const kind of COUNTED_GRAPH_EDGE_KINDS) total += edges[kind].length;
  return total;
}

/**
 * What a file over the cap persists: its row with no edges of any kind. The
 * empty required lists also retire whatever the file stored while it was still
 * under the cap. A fresh value per call, so no two buffered files share one.
 */
export function pathologicalFileGraphEdges(): GraphEdges {
  return { fileEdges: [], methodEdges: [] };
}
