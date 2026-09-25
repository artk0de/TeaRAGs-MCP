import type { DeclaredSymbolVisibility } from "../../../contracts/types/codegraph.js";

export interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * The declared visibility of the member an outline line names, by
 * (relativePath, symbolId) — `undefined` when unknown, which renders the bare
 * id (bd tea-rags-mcp-sqqkz). Outline rendering stays pure: the caller owns the
 * codegraph read and hands the answer in.
 */
export type MemberVisibilityLookup = (relativePath: string, symbolId: string) => DeclaredSymbolVisibility | undefined;
