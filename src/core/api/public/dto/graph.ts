/**
 * Codegraph DTOs — request/response shapes for the `get_callers`,
 * `get_callees`, and `find_cycles` MCP tools.
 */

import type { CycleScope, RelPath, SymbolId } from "../../../contracts/types/codegraph.js";

export interface GetCallersRequest {
  path: string;
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
  path: string;
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
  path: string;
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
