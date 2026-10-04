
CREATE TABLE IF NOT EXISTS cg_temporal_symbol_commits (
  rel_path     VARCHAR NOT NULL,
  symbol_id    VARCHAR NOT NULL,
  commit_shas  VARCHAR NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);
