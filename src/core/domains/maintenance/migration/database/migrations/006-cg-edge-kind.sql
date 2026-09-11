
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS edge_kind VARCHAR DEFAULT 'exact';
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS confidence REAL DEFAULT 1.0;

CREATE TABLE IF NOT EXISTS cg_run_stats (
  receiver_kind VARCHAR PRIMARY KEY,
  attempted     INTEGER NOT NULL,
  resolved      INTEGER NOT NULL
);
