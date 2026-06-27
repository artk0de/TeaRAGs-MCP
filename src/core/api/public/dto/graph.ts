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

import type { CycleScope, RelPath, SymbolId } from "../../../contracts/types/codegraph.js";
import type { RankingOverlay } from "../../../contracts/types/reranker.js";

export interface GetCallersRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  symbolId: SymbolId;
  limit?: number;
}

export interface CallerResult {
  sourceSymbolId: SymbolId;
  sourceRelPath: RelPath;
  callExpression: string;
}

export interface GetCallersResponse {
  callers: CallerResult[];
}

export interface GetCalleesRequest {
  /** Project alias from the collection registry — RECOMMENDED. */
  project?: string;
  /** Explicit Qdrant collection name — highest priority. */
  collection?: string;
  /** Filesystem path to the indexed codebase — backward-compat fallback. */
  path?: string;
  symbolId: SymbolId;
  limit?: number;
}

export interface CalleeResult {
  targetSymbolId: SymbolId | null;
  targetRelPath: RelPath;
  callExpression: string;
}

export interface GetCalleesResponse {
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
  /** Members in walk order. */
  members: string[];
  /** Convenience — member count (always >= 2). */
  length: number;
}

export interface FindCyclesResponse {
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

export interface PathStep {
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

export interface PathTraceResult {
  /** Sorted by aggregateDanger, most dangerous first. */
  paths: TracedPath[];
  /** True if maxPaths/maxDepth capped enumeration. */
  truncated: boolean;
}
