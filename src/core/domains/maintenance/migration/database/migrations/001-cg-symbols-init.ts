/**
 * Slice 1 codegraph schema (`cg_symbols_*`).
 *
 * Inlined as a TS string so the migration runner is filesystem-free and
 * the compiled `build/` artifact ships the SQL alongside the JS. See
 * `src/core/adapters/duckdb/client.ts` for the FK / CASCADE deviations
 * forced by DuckDB.
 */
export const SQL_001_CG_SYMBOLS_INIT = `
CREATE TABLE IF NOT EXISTS cg_symbols_files (
  rel_path  VARCHAR PRIMARY KEY,
  language  VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS cg_symbols_edges_file (
  source_rel_path  VARCHAR NOT NULL,
  target_rel_path  VARCHAR NOT NULL,
  import_text      VARCHAR,
  PRIMARY KEY (source_rel_path, target_rel_path)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_file_target
  ON cg_symbols_edges_file (target_rel_path);

CREATE TABLE IF NOT EXISTS cg_symbols_edges_method (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  PRIMARY KEY (source_symbol_id, call_expression, target_symbol_id)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);
`;
