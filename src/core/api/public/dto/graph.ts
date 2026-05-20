/**
 * Codegraph DTOs — request/response shapes for the `get_callers` and
 * `get_callees` MCP tools.
 */

import type { RelPath, SymbolId } from "../../../contracts/types/codegraph.js";

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
