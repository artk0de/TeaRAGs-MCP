/**
 * The `cg_symbols` row codec — the ONE place a {@link SymbolDefinition} turns
 * into persisted columns and back. Both write paths (per-file `upsertSymbols`
 * and batched `upsertSymbolsBulk`) and the hydration SELECT share the column
 * list and the two mapping functions here, so a new definition field cannot
 * land on one path and silently miss the other.
 */

import type { AritySignature, KwargSignature, SymbolDefinition } from "../../contracts/types/codegraph.js";

/**
 * The `cg_symbols` columns that carry a {@link SymbolDefinition} — the single
 * source of truth for BOTH write paths (per-file `upsertSymbols` and batched
 * `upsertSymbolsBulk`) and the hydration SELECT. Order matches
 * {@link toCgSymbolsRow}'s tuple; a new definition field means editing this
 * list, that projection and {@link fromCgSymbolsRow} — the three places the
 * compiler and the round-trip tests hold together.
 *
 * `chunk_id` is deliberately absent: it is not part of a definition, it is
 * backfilled after chunking by `updateSymbolChunkIds`.
 *
 * Column names are compile-time literals, never user input; every VALUE goes
 * through a positional bind.
 */
export const CG_SYMBOLS_DEF_COLUMNS = [
  "rel_path",
  "symbol_id",
  "fq_name",
  "short_name",
  "scope_json",
  "arity_json",
  "visibility",
  "kwargs_json",
  "accepts_block",
  "is_abstract_stub",
] as const;

export const CG_SYMBOLS_DEF_INSERT_SQL = `INSERT OR IGNORE INTO cg_symbols (${CG_SYMBOLS_DEF_COLUMNS.join(", ")}) VALUES (${CG_SYMBOLS_DEF_COLUMNS.map(
  () => "?",
).join(", ")})`;

/** Raw `cg_symbols` row as read back by `DuckDbSymbolStore.listAllSymbols`. */
export interface CgSymbolsRow {
  rel_path: string;
  symbol_id: string;
  fq_name: string;
  short_name: string;
  scope_json: string;
  arity_json: string | null;
  visibility: string | null;
  kwargs_json: string | null;
  accepts_block: boolean | null;
  /** NULL on a row written before migration 016 — read as "not a stub". */
  is_abstract_stub: boolean | null;
}

/**
 * Project a definition onto the `cg_symbols` tuple — the ONE write-direction
 * mapping point, shared by the per-file and the batched writer so a new field
 * cannot land on one path and silently miss the other (which is exactly how
 * `isAbstractStub` shipped unpersisted, bd tea-rags-mcp-eikry).
 */
export function toCgSymbolsRow(def: SymbolDefinition): unknown[] {
  return [
    def.relPath,
    def.symbolId,
    def.fqName,
    def.shortName,
    JSON.stringify(def.scope ?? []),
    def.arity ? JSON.stringify(def.arity) : null,
    def.visibility ?? null,
    def.kwargs ? JSON.stringify(def.kwargs) : null,
    def.acceptsBlock ?? null,
    def.isAbstractStub === true,
  ];
}

/**
 * Rebuild a definition from its persisted row — the ONE read-direction mapping
 * point (the symbol-table hydration seam every incremental run goes through).
 * Optional fields stay ABSENT rather than explicitly undefined, so a hydrated
 * def is shape-identical to a freshly walked one.
 */
export function fromCgSymbolsRow(row: CgSymbolsRow): SymbolDefinition {
  return {
    relPath: row.rel_path,
    symbolId: row.symbol_id,
    fqName: row.fq_name,
    shortName: row.short_name,
    scope: parseScope(row.scope_json),
    ...(row.arity_json ? { arity: JSON.parse(row.arity_json) as AritySignature } : {}),
    ...(row.visibility ? { visibility: row.visibility as SymbolDefinition["visibility"] } : {}),
    ...(row.kwargs_json ? { kwargs: JSON.parse(row.kwargs_json) as KwargSignature } : {}),
    ...(row.accepts_block !== null && row.accepts_block !== undefined ? { acceptsBlock: row.accepts_block } : {}),
    // Only-ever-true, like the walker's mark: an explicit TRUE marks a stub,
    // and FALSE / NULL (pre-016 row) both mean "not a stub".
    ...(row.is_abstract_stub === true ? { isAbstractStub: true } : {}),
  };
}

function parseScope(json: string): string[] {
  // Scope is stored as JSON-encoded VARCHAR (see migration 002 — DuckDB
  // list-type bindings add complexity for a small array). Tolerate a
  // malformed scalar by returning empty: a missing scope chain degrades
  // resolver precision but never crashes hydration.
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
