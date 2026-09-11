-- Codegraph schema — previous-run symbol/file signals (bd tea-rags-mcp-a2ddb).
-- `cg_symbols_metrics` and the edge tables are recomputed wholesale every run,
-- but the Qdrant payload derived from them was rewritten only for files in the
-- run's chunk map. A file that stopped changing kept the fanIn / fanOut /
-- pageRank it had when it last changed while the graph under it moved. These
-- two tables hold the signals as of the END of the previous run; the coordinator
-- diffs the fresh signals against them and the payload healer rewrites exactly
-- the points whose signals moved. Empty after this migration, so the first run
-- heals every point once (one payload sweep, no extraction) and later runs are
-- bounded by what actually changed.
--
-- `fan_in` / `fan_out` are DOUBLE on the SYMBOL table and BIGINT on the FILE
-- table because the two metrics are not the same shape: chunk fan is the
-- confidence-weighted SUM(COALESCE(confidence, 1.0)) an m-way dynamic fan-out
-- contributes 1/m to (bd tea-rags-mcp-s5ato), so it is fractional; file fan is
-- a plain COUNT over `cg_symbols_edges_file`. Storing the symbol side as BIGINT
-- would round every fractional value to the same integer and hide exactly the
-- movement this table exists to detect.
--
-- Companion `.ts` is what production loads. Keep in sync.

CREATE TABLE IF NOT EXISTS cg_symbol_signals_prev (
  rel_path   VARCHAR NOT NULL,
  symbol_id  VARCHAR NOT NULL,
  fan_in     DOUBLE  NOT NULL,
  fan_out    DOUBLE  NOT NULL,
  page_rank  DOUBLE  NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);

CREATE TABLE IF NOT EXISTS cg_file_signals_prev (
  rel_path  VARCHAR PRIMARY KEY,
  fan_in    BIGINT NOT NULL,
  fan_out   BIGINT NOT NULL
);
