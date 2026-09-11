
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
