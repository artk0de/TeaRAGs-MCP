/**
 * Codegraph DTOs — request/response shapes for the `get_callers`,
 * `get_callees`, and `find_cycles` MCP tools.
 *
 * Each request carries the standard `{ collection, project, path }`
 * triad every other tea-rags tool accepts (resolution priority:
 * `collection > project > path`). All three fields are optional at
 * the type level; the facade rejects requests that supply none of
 * them with a typed `CollectionNotProvidedError`.
 */

import type {
  CycleScope,
  DeclaredSymbolVisibility,
  EdgeOrigin,
  RelPath,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { EmptyAnswerExplanation } from "../../../contracts/types/empty-answer.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { WorkingTreeMarker, WorkingTreeState } from "../../../contracts/types/working-tree.js";

export interface GetCallersRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** Target symbol. Exactly one of `symbolId` / `relativePath` is required. */
  symbolId?: SymbolId;
  /**
   * Target FILE (repo-relative) — switches the answer to file scope: the files
   * importing it, read from the file edge table (bd tea-rags-mcp-gfvr8).
   * Exactly one of `symbolId` / `relativePath` is required.
   */
  relativePath?: RelPath;
  limit?: number;
  /** Rows to skip before `limit` — the continuation `truncated.next` carries (bd tea-rags-mcp-afdpc). */
  offset?: number;
  /**
   * symbolId scope only: hops to walk, 1–3 (default 1). Above 1 the answer is a
   * BFS `tree` instead of the one-hop list (bd tea-rags-mcp-afdpc).
   */
  depth?: number;
  /**
   * Opt-in lazy ambiguous expansion (bd tea-rags-mcp-f2jsb A4): also fetch
   * `cg_ambiguous_fanout` aggregates whose member matches the target's member
   * segment and attach them as `ambiguousCallers`. Default false — the
   * response stays byte-identical to the pre-flag shape.
   */
  includeAmbiguous?: boolean;
}

/**
 * Declared visibility on graph-tool entries (bd tea-rags-mcp-sqqkz), read from
 * `cg_symbols.visibility`. OMITTED when unknown — the walker recorded none, the
 * symbol is not in the graph, or codegraph could not be read. Never `null`,
 * never a default of `public`: a missing field reads as "unknown".
 */
export interface DeclaredVisibilityField {
  visibility?: DeclaredSymbolVisibility;
}

/** One caller; `visibility` is the CALLER symbol's own. */
/**
 * A class / module id answers its members' edges too (bd tea-rags-mcp-znzv3):
 * a rolled-up row names the member it reaches (`member` = separator + member
 * segment under the queried id, `#run` / `.call`); `memberRollup` says the
 * answer was rolled up. Edges between the container's own members are counted
 * in `internalCallers` / `internalCallees`, never listed.
 */
export interface ContainerMemberRollup {
  /** Direct members whose edges were read. */
  members: number;
  /** Distinct caller+member pairs whose caller is inside the container. */
  internalCallers?: number;
  /** Distinct member+target pairs whose target is inside the container. */
  internalCallees?: number;
}

export interface ContainerMemberRollupField {
  memberRollup?: ContainerMemberRollup;
}

/** The member a rolled-up row belongs to; absent on the queried symbol's own edges. */
export interface ContainerMemberRowField {
  member?: string;
}

export interface CallerResult extends DeclaredVisibilityField, GraphRowTreeStateField, ContainerMemberRowField {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
  /** `"model"` when a residual-resolution verdict produced the edge; absent means a static edge. */
  origin?: EdgeOrigin;
  /** Provider id of a model edge. */
  model?: string;
  /** Provider probability of a model edge. */
  p?: number;
}

/**
 * Ambiguous dispatch site whose member matches the target (bd f2jsb): the
 * call MAY reach the target among `candidateCount` candidates. NOT a
 * materialized edge — the over-cap fan-out was persisted as one aggregate
 * row instead of m edges.
 */
export interface AmbiguousCallerResult extends GraphRowTreeStateField {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
  candidateCount: number;
}

/**
 * `get_callers` / `get_callees` answer: symbol scope when the request named a
 * `symbolId`, file scope when it named a `relativePath`.
 */
export type GetCallersResponse = (SymbolCallersResponse | FileImportersResponse | SymbolCallTreeResponse) &
  WorkingTreeMarkerField;
export type GetCalleesResponse = (SymbolCalleesResponse | FileImportsResponse | SymbolCallTreeResponse) &
  WorkingTreeMarkerField;

/** Rows a `depth > 1` get_callers / get_callees answer returns when the request names no `limit` (bd tea-rags-mcp-afdpc). */
export const CALL_TREE_DEFAULT_LIMIT = 40;

/** Deepest call tree a request may ask for: three hops already map a flow end to end. */
export const CALL_TREE_MAX_DEPTH = 3;

/**
 * The page cut a graph answer made (bd tea-rags-mcp-afdpc): rows returned, rows
 * past the window. The MCP layer attaches `next` — the same call with
 * `offset` advanced by `returned`.
 */
export interface GraphPageTruncation {
  returned: number;
  omitted: number;
}

/** Present only when rows exist past `offset + limit`; an answer that fits carries none. */
export interface GraphPageTruncationField {
  truncated?: GraphPageTruncation;
}

/**
 * One row of a `depth > 1` answer (bd tea-rags-mcp-afdpc), in BFS order:
 * `parent` is the node the edge leaves (the queried symbol at depth 1) — a
 * symbol is expanded once, so a parent id names one row. `seen` marks a
 * back-reference to a symbol listed earlier, not expanded again; `external` =
 * the expanded node's call sites pinned to no in-project symbol.
 */
export interface CallTreeRow extends GraphRowTreeStateField, ContainerMemberRowField {
  depth: number;
  parent: SymbolId;
  symbolId: SymbolId;
  relPath: RelPath;
  edgeKind?: string;
  confidence?: number;
  origin?: EdgeOrigin;
  external?: number;
  seen?: true;
  /** First code line of the symbol's chunk, as a metaOnly search row's `signature`. */
  signature?: string;
}

/** `get_callers` / `get_callees` with `depth > 1`: the reverse / forward call tree of `symbolId`. */
export interface SymbolCallTreeResponse
  extends
    ResolvedSymbolIdField,
    EmptyAnswerField,
    GraphPageTruncationField,
    GraphNoticesField,
    QueriedTreeStateField,
    ContainerMemberRollupField {
  tree: CallTreeRow[];
  /** get_callees: the queried symbol's own call sites pinned to no in-project symbol. Absent when none. */
  unresolved?: number;
}

/**
 * Which working tree a graph answer was read for (bd tea-rags-mcp-xi2r9). With
 * a non-empty delta the answer is read from the tree's graph (WTO-7) and
 * `floors` holds `"codegraph"`; when that graph could not be had in time,
 * edges are the INDEX's and `treeGraphUnavailable` says why. A clean tree
 * reads the index graph, which is the tree's. Present whenever the server
 * wires the overlay, on every return path.
 */
export interface WorkingTreeMarkerField {
  workingTree?: WorkingTreeMarker;
}

/**
 * One file on the other end of a file edge (bd tea-rags-mcp-gfvr8): an importer
 * for `get_callers`, an imported file for `get_callees`.
 */
export interface FileImportResult extends GraphRowTreeStateField {
  relativePath: RelPath;
  /** The import text the walker recorded; null on a row that carries none. */
  importText: string | null;
  /**
   * Confidence-weighted count of the resolved calls crossing this import —
   * 0 when the dependency carries no resolved call (a type, a constant, a
   * re-export). Results are ordered by it, heaviest first.
   */
  callWeight: number;
  /** The part of `callWeight` a residual model resolved; absent when none did. */
  modelCallWeight?: number;
  /** `"model"` when no import links the files — a residual model's call alone does. */
  origin?: "model";
}

interface FileScopeResponseBase extends EmptyAnswerField, GraphPageTruncationField, QueriedTreeStateField {
  /** The file the request named, normalised (a leading `./` stripped). */
  relativePath: RelPath;
  /** Edge count before `limit` was applied. */
  total: number;
  /**
   * Present when the codegraph has no such file — the path is not
   * repo-relative, has a typo, or its language is not walked. An empty list on
   * a known file carries no message: nothing imports it (or it imports nothing).
   */
  message?: string;
}

/** File-scope `get_callers`: the files importing `relativePath`. */
export interface FileImportersResponse extends FileScopeResponseBase {
  importers: FileImportResult[];
}

/** File-scope `get_callees`: the files `relativePath` imports. */
export interface FileImportsResponse extends FileScopeResponseBase {
  imports: FileImportResult[];
}

/**
 * Host-class aliasing (bd tea-rags-mcp-63l69). A member a mixin, concern or
 * superclass defines is keyed by its DEFINER; a request naming the host
 * (`Account.suspended`) with no node or edges of its own is answered through
 * the first definer up the persisted hierarchy in MRO order
 * (`Account::Suspensions.suspended`). PRESENT only when that happened — the
 * definer id actually queried; absent on every unaliased answer.
 */
export interface ResolvedSymbolIdField {
  resolvedSymbolId?: SymbolId;
}

/**
 * A graph row read from the INDEX's graph for a tree whose own graph was
 * unavailable (bd tea-rags-mcp-07b9w): `treeState` when the row's file is one
 * the tree changed — the edge may be stale — with the search rows' vocabulary.
 * Absent = the edge is exact for the tree.
 */
export interface GraphRowTreeStateField {
  treeState?: WorkingTreeState;
}

/**
 * Same condition as {@link GraphRowTreeStateField}, for the QUERIED symbol or
 * file itself: its own file is in the tree's delta, so the index's edges of it
 * may be stale. Absent otherwise.
 */
export interface QueriedTreeStateField {
  queriedTreeState?: WorkingTreeState;
}

/**
 * Why a graph answer is empty (agent turn economy N6) — `unknownSymbol` (no
 * node under either separator; `suggestions` = ids defined under the short
 * name), `noEdges` (node present, no edges; a lower bound when its language's
 * resolve rate is low), `unknownFile`, `treeOnly` (defined only in the tree,
 * whose graph was unavailable). Absent on every non-empty answer and on
 * a collection with no graph database.
 */
export interface EmptyAnswerField {
  empty?: EmptyAnswerExplanation;
}

/**
 * Advisory lines on a graph answer that still stands (bd tea-rags-mcp-nknkg.1):
 * Rust edges read while the rustc driver did not index are static-only, so a
 * Rust caller/callee list, an empty Rust trace or an empty cycle list over Rust
 * is a lower bound. Absent when there is nothing to say; an empty symbol answer
 * says it in `empty.message` instead.
 */
export interface GraphNoticesField {
  notices?: string[];
}

export interface SymbolCallersResponse
  extends
    ResolvedSymbolIdField,
    EmptyAnswerField,
    GraphPageTruncationField,
    GraphNoticesField,
    QueriedTreeStateField,
    ContainerMemberRollupField {
  /**
   * The QUERIED symbol's declared visibility — present only when every
   * definition of the symbolId (namesakes included) states the same level.
   */
  visibility?: DeclaredSymbolVisibility;
  callers: CallerResult[];
  /**
   * Present ONLY when the request set `includeAmbiguous: true` AND the target
   * symbolId carries a member segment (text after the last `#` or `.`).
   * Ambiguous dispatch sites whose member matches the target — each MAY reach
   * it among `candidateCount` candidates; not materialized as edges (bd f2jsb).
   */
  ambiguousCallers?: AmbiguousCallerResult[];
}

export interface GetCalleesRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** Source symbol. Exactly one of `symbolId` / `relativePath` is required. */
  symbolId?: SymbolId;
  /**
   * Source FILE (repo-relative) — switches the answer to file scope: the files
   * it imports (bd tea-rags-mcp-gfvr8).
   */
  relativePath?: RelPath;
  limit?: number;
  /** Rows to skip before `limit` — the continuation `truncated.next` carries (bd tea-rags-mcp-afdpc). */
  offset?: number;
  /**
   * symbolId scope only: hops to walk, 1–3 (default 1). Above 1 the answer is a
   * BFS `tree` instead of the one-hop list (bd tea-rags-mcp-afdpc).
   */
  depth?: number;
}

/** One callee; `visibility` is the TARGET symbol's own (never set on a file-only edge). */
export interface CalleeResult extends DeclaredVisibilityField, GraphRowTreeStateField, ContainerMemberRowField {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
  /** Call sites reaching this target, when more than one collapsed into the row (`callExpression` is the first). */
  count?: number;
  /** `"model"` when a residual-resolution verdict produced the edge; absent means a static edge. */
  origin?: EdgeOrigin;
  /** Provider id of a model edge. */
  model?: string;
  /** Provider probability of a model edge. */
  p?: number;
}

export interface SymbolCalleesResponse
  extends
    ResolvedSymbolIdField,
    EmptyAnswerField,
    GraphPageTruncationField,
    GraphNoticesField,
    QueriedTreeStateField,
    ContainerMemberRollupField {
  /** Callees with a resolved target symbol only. */
  callees: CalleeResult[];
  /** Call sites the resolver pinned to no target symbol; they are not `callees` rows. Absent when none. */
  unresolved?: number;
  /** Up to five distinct call expressions among the `unresolved` sites. */
  unresolvedCalls?: string[];
}

// ── Slice 2 / B2 — find_cycles ──

export interface FindCyclesRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** 'file' = circular imports between files; 'method' = circular calls between symbols. */
  scope: CycleScope;
  /**
   * Picomatch glob scoping the result to a subdomain/module. A cycle is
   * kept iff AT LEAST ONE member resolves to a matching file path, so
   * cross-boundary cycles are retained. Omit for no filter.
   */
  pathPattern?: string;
}

export interface CycleResult {
  /** Numeric id assigned at recompute time. Stable within one recompute. */
  cycleId: number;
  scope: CycleScope;
  /** Members in walk order: relPaths (file scope) or bare symbolIds (method scope). */
  members: string[];
  /**
   * Method scope only — per member, index-aligned with `members`: its symbolId
   * and the file that declares it. Tells namesakes apart (two `init` in one Go
   * package, every top-level `main`), which the bare `members` entry cannot.
   * `relativePath` is `""` for a cycle not yet recomputed since migration 028.
   */
  memberLocations?: CycleResultMemberLocation[];
  /** Convenience — member count (always >= 2). */
  length: number;
  /**
   * True when at least one member-to-member hop is supported only by
   * residual-model edges (a hop any static edge supports stays static).
   * Absent when every hop is static.
   */
  hasModelEdge?: boolean;
  /** Number of model-only hops inside the cycle; present with `hasModelEdge`. */
  modelEdgeCount?: number;
}

export interface CycleResultMemberLocation extends GraphRowTreeStateField {
  symbolId: SymbolId;
  relativePath: RelPath;
}

export interface FindCyclesResponse extends WorkingTreeMarkerField, GraphNoticesField {
  cycles: CycleResult[];
}

// ── Slice 6 — trace_path ──

export interface TracePathRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  /** Start symbol of the path (caller end). */
  from: SymbolId;
  /** End symbol of the path (callee end). */
  to: SymbolId;
  /**
   * Exact relative path disambiguating `from` when the symbolId names several
   * files (bd tea-rags-mcp-oxnvl). Top-level declarations carry bare symbolIds,
   * so `BaseTable` can denote three files; omit to trace from all of them, pass
   * one to pin the start. A path matching no candidate yields no paths plus the
   * `namesakes` listing of what was actually available.
   */
  fromPath?: RelPath;
  /** Exact relative path disambiguating `to`. Same semantics as `fromPath`. */
  toPath?: RelPath;
  /**
   * Optional rerank preset that scores per-step "danger" for the overlay.
   * When omitted, trace_path returns a LEAN path enumeration — steps carry
   * only {symbolId, relativePath, startLine, endLine}, paths stay in
   * enumeration order, and dangerRanking/aggregateDanger are absent. Pass a
   * per-step danger preset (bugHunt / dangerous / hotspots / blastRadius) to
   * attach the overlay and danger-sort the path list; group presets (e.g.
   * refactoring) are not meaningful here — danger is scored per step.
   */
  rerank?: string;
  /** Max hops on a path (edge count). Default 8. */
  maxDepth?: number;
  /** Max paths returned, sorted by aggregateDanger desc. Default 10. */
  maxPaths?: number;
}

export interface PathStep extends DeclaredVisibilityField, GraphRowTreeStateField {
  /** Class#method (instance) / Class.method (static) / functionName. */
  symbolId: SymbolId;
  relativePath: RelPath;
  startLine: number;
  endLine: number;
  /** bugFixRate / churn / ownership labels from the chosen rerank preset. */
  dangerOverlay?: RankingOverlay;
  /**
   * `"model"` when the hop INTO this step is supported only by residual-model
   * edges (a hop any static call site supports stays static); absent on the
   * first step and on a static hop.
   */
  origin?: EdgeOrigin;
  /** Provider id of the strongest model verdict on the incoming hop. */
  model?: string;
  /** Highest provider probability among the incoming hop's model call sites. */
  p?: number;
}

export interface TracedPath {
  /** ORDERED — execution order, never reordered. */
  steps: PathStep[];
  /**
   * Indices into `steps`, sorted by per-step danger desc (where to look
   * first). Present ONLY when a `rerank` preset was supplied; absent for a
   * lean (no-rerank) trace.
   */
  dangerRanking?: number[];
  /**
   * Path-level score = max per-step danger; sorts the path list. Present
   * ONLY when a `rerank` preset was supplied; absent for a lean trace.
   */
  aggregateDanger?: number;
  /** Lowest `p` among the path's model hops; absent when every hop is static. */
  minP?: number;
}

export interface PathTraceResult extends WorkingTreeMarkerField, EmptyAnswerField, GraphNoticesField {
  /** Sorted by aggregateDanger, most dangerous first. */
  paths: TracedPath[];
  /** True if maxPaths/maxDepth capped enumeration. */
  truncated: boolean;
  /**
   * Candidate files for each endpoint, present ONLY when at least one of them
   * matched more than one file (bd tea-rags-mcp-oxnvl) — the caller's cue that
   * the trace spans namesakes and that `fromPath` / `toPath` would narrow it.
   * Lists the PRE-filter candidates, so a request that already passed a path
   * still sees what it excluded. Absent when both endpoints are unambiguous.
   */
  namesakes?: { from: RelPath[]; to: RelPath[] };
  /**
   * Host-class aliasing on the endpoints (bd tea-rags-mcp-u0t4p) — the same
   * policy as `ResolvedSymbolIdField`: a `from` / `to` naming a member the
   * host inherits, with no node of its own, is traced from / to the member's
   * definer. Each key is PRESENT only for an endpoint that was aliased, and
   * names the definer id actually traced; the field is absent when neither was.
   */
  resolvedEndpoints?: { from?: SymbolId; to?: SymbolId };
}
