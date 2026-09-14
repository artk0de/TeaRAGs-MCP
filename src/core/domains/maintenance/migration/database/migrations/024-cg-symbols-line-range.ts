/**
 * Codegraph schema — persist each symbol's walker line range on `cg_symbols`
 * (bd tea-rags-mcp-9i2ow).
 *
 * Two writers put `codegraph.symbols.chunk.*` on the same Qdrant points and now
 * resolve the owning symbol through ONE rule, which needs every symbol's line
 * range. The deferred chunk pass has it from the walk; the payload healer runs
 * outside any walk and had only the chunk's payload symbolId, so a nested symbol
 * whose fan moved never reached the points it owns. These columns are that range,
 * written by the same row diff as the rest of the definition.
 *
 * Nullable with no default: a row written before this migration reads back
 * NULL, and the owner rule treats "no range" as "keep the chunk's own payload
 * symbolId" — exactly what the healer did before. Any default would assert a
 * range nobody measured.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_024_CG_SYMBOLS_LINE_RANGE = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS start_line INTEGER;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS end_line INTEGER;
`;
