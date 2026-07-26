/**
 * Slice 2 codegraph schema — `cg_symbols`.
 *
 * Persists symbol definitions emitted by the extraction walker so the
 * in-memory `GlobalSymbolTable` can hydrate from disk on cold start and
 * cross-file call resolution survives partial reindexes (incremental
 * reindex of file A can still resolve calls into unchanged file B).
 *
 * Scope is stored as a JSON-encoded VARCHAR — DuckDB's list types add
 * binding complexity without buying anything for small arrays (most
 * scopes are <= 2 segments). The JSON round-trip happens inside the
 * adapter; callers see `string[]`.
 */
export const SQL_002_CG_SYMBOLS_TABLE = `
CREATE TABLE IF NOT EXISTS cg_symbols (
  rel_path    VARCHAR NOT NULL,
  symbol_id   VARCHAR NOT NULL,
  fq_name     VARCHAR NOT NULL,
  short_name  VARCHAR NOT NULL,
  scope_json  VARCHAR NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_fq ON cg_symbols (fq_name);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_short ON cg_symbols (short_name);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_rel_path ON cg_symbols (rel_path);
`;
