-- Codegraph slice 1 initial schema.
--
-- Three tables, all under the `cg_symbols_` prefix per the sub-graph
-- naming convention (`cg_<subtype>_*`). Slice 5 will add `cg_temporal_*`
-- alongside; Slice 2 will add `cg_symbols_cycles`.

CREATE TABLE IF NOT EXISTS cg_symbols_files (
  rel_path  VARCHAR PRIMARY KEY,
  language  VARCHAR NOT NULL
);

-- NOTE: the spec's `ON DELETE CASCADE` and FOREIGN KEY constraints are
-- intentionally omitted in the DuckDB adapter. As of @duckdb/node-api
-- 1.5.x:
--   1. DuckDB's DDL parser rejects FK with ON DELETE CASCADE entirely.
--   2. Plain FK without CASCADE produces transient false-positive
--      "key still referenced" errors during multi-statement transactions
--      using prepared statements — the cleanup DELETE has run, but the
--      following DELETE on the parent row sees stale FK state.
-- Codegraph manages its own referential integrity end-to-end:
--   • `DuckDbGraphClient.upsertFile` deletes all dependent edge rows of
--     the upserted file before re-inserting.
--   • `DuckDbGraphClient.removeFile` deletes all edges referencing the
--     file (source OR target side) before deleting the file row.
-- Slice 4's PostgresGraphClient can declare FK + ON DELETE CASCADE
-- restored — no contract change required.

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
