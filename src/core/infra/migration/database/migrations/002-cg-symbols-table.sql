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
