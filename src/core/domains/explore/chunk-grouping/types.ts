import type { DeclaredSymbolVisibility, InheritanceEdge } from "../../../contracts/types/codegraph.js";

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

/**
 * The direct ancestors of the container an outline is headed by, by its
 * symbolId, in the order the outline lists them (bd tea-rags-mcp-82cot) —
 * `undefined` when unknown, which renders no ancestor line. Outline rendering
 * stays pure: the caller owns the codegraph read and hands the answer in.
 */
export type ContainerAncestorLookup = (containerSymbolId: string) => readonly InheritanceEdge[] | undefined;
