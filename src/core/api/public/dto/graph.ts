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

import type { CycleScope, DeclaredSymbolVisibility, RelPath, SymbolId } from "../../../contracts/types/codegraph.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";
import type { WorkingTreeMarker } from "../../../contracts/types/working-tree.js";

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
export interface CallerResult extends DeclaredVisibilityField {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
}

/**
 * Ambiguous dispatch site whose member matches the target (bd f2jsb): the
 * call MAY reach the target among `candidateCount` candidates. NOT a
 * materialized edge — the over-cap fan-out was persisted as one aggregate
 * row instead of m edges.
 */
export interface AmbiguousCallerResult {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
  candidateCount: number;
}

/**
 * `get_callers` / `get_callees` answer: symbol scope when the request named a
 * `symbolId`, file scope when it named a `relativePath`.
 */
export type GetCallersResponse = (SymbolCallersResponse | FileImportersResponse) & WorkingTreeMarkerField;
export type GetCalleesResponse = (SymbolCalleesResponse | FileImportsResponse) & WorkingTreeMarkerField;

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
export interface FileImportResult {
  relativePath: RelPath;
  /** The import text the walker recorded; null on a row that carries none. */
  importText: string | null;
  /**
   * Confidence-weighted count of the resolved calls crossing this import —
   * 0 when the dependency carries no resolved call (a type, a constant, a
   * re-export). Results are ordered by it, heaviest first.
   */
  callWeight: number;
}

interface FileScopeResponseBase {
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

export interface SymbolCallersResponse extends ResolvedSymbolIdField {
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
}

/** One callee; `visibility` is the TARGET symbol's own (never set on a file-only edge). */
export interface CalleeResult extends DeclaredVisibilityField {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
}

export interface SymbolCalleesResponse extends ResolvedSymbolIdField {
  callees: CalleeResult[];
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
  memberLocations?: CycleMemberLocation[];
  /** Convenience — member count (always >= 2). */
  length: number;
}

export interface CycleMemberLocation {
  symbolId: SymbolId;
  relativePath: RelPath;
}

export interface FindCyclesResponse extends WorkingTreeMarkerField {
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

export interface PathStep extends DeclaredVisibilityField {
  /** Class#method (instance) / Class.method (static) / functionName. */
  symbolId: SymbolId;
  relativePath: RelPath;
  startLine: number;
  endLine: number;
  /** bugFixRate / churn / ownership labels from the chosen rerank preset. */
  dangerOverlay?: RankingOverlay;
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
}

export interface PathTraceResult extends WorkingTreeMarkerField {
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
