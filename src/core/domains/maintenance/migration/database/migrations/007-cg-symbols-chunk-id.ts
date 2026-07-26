/**
 * Adds the covering-chunk reference to each symbol row. `chunk_id` is the
 * `chunk_<hash16>` form (pre-normalizeId) of the tightest Qdrant chunk that
 * contains the symbol's declaration — populated in the codegraph deferred
 * chunk pass via a line-range containment join. Nullable: NULL when a symbol
 * has no covering chunk (excluded file) or the row predates this migration /
 * its backfill. `idx_cg_symbols_symbol` backs the new lookup-by-symbol_id
 * read path (`findSymbolChunk`); pre-existing reads were full-scan only.
 */
export const SQL_007_CG_SYMBOLS_CHUNK_ID = `
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS chunk_id VARCHAR;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_symbol ON cg_symbols (symbol_id);
`;
