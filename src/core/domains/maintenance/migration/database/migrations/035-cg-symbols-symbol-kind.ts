/**
 * Codegraph schema — the declaration kind of a definition on `cg_symbols`
 * (bd tea-rags-mcp-vi0wx).
 *
 * Type-name judgement in the naming lexicon has to tell a type (`class`,
 * `module`, `interface`, `enum`, `type_alias`) from a `constant`, a `function`
 * or a `method`, and only the walker knows which declaration node it read.
 * `symbol_kind` persists that fact (`SymbolDefinition.symbolKind`), so a def
 * hydrated from disk on an incremental run carries the same kind as a freshly
 * walked one.
 *
 * Nullable, no DEFAULT: a row written before the column — or by a walker that
 * records no kind — has no such fact, and NULL reads as "unknown", which the
 * lexicon excludes from type-name judgement. A default would fabricate a kind.
 * The walker bumps that start writing it route `--force-enrichments codegraph`,
 * which rewrites the rows with the real value.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_035_CG_SYMBOLS_SYMBOL_KIND = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS symbol_kind VARCHAR;
`;
