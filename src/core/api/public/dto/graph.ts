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
