
CREATE TABLE IF NOT EXISTS cg_symbols_edges_method_v2 (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path  VARCHAR NOT NULL,
  target_symbol_id VARCHAR,
  target_rel_path  VARCHAR NOT NULL,
  call_expression  VARCHAR NOT NULL,
  edge_kind        VARCHAR DEFAULT 'exact',
  confidence       REAL DEFAULT 1.0,
  PRIMARY KEY (source_symbol_id, source_rel_path, call_expression, target_symbol_id)
);

INSERT OR IGNORE INTO cg_symbols_edges_method_v2
  (source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence)
SELECT source_symbol_id, source_rel_path, target_symbol_id, target_rel_path, call_expression, edge_kind, confidence
  FROM cg_symbols_edges_method;

DROP TABLE cg_symbols_edges_method;

ALTER TABLE cg_symbols_edges_method_v2 RENAME TO cg_symbols_edges_method;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_symbol
  ON cg_symbols_edges_method (target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_target_rel_path
  ON cg_symbols_edges_method (target_rel_path);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_edges_method_source_rel_path
  ON cg_symbols_edges_method (source_rel_path);
