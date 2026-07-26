CREATE TABLE IF NOT EXISTS cg_symbols_metrics (
  symbol_id   VARCHAR PRIMARY KEY,
  page_rank   DOUBLE NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_metrics_page_rank ON cg_symbols_metrics (page_rank);
