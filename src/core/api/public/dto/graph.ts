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
  /** Rerank preset that defines "danger" for the overlay. Default: bugHunt. */
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
  /** Indices into `steps`, sorted by per-step danger desc (where to look first). */
  dangerRanking: number[];
  /** Path-level score = max per-step danger; used to sort the path list. */
  aggregateDanger: number;
}

export interface PathTraceResult {
  /** Sorted by aggregateDanger, most dangerous first. */
  paths: TracedPath[];
  /** True if maxPaths/maxDepth capped enumeration. */
  truncated: boolean;
}
