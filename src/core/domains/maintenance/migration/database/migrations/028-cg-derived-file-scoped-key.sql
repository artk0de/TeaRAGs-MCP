
CREATE TABLE IF NOT EXISTS cg_symbols_cycles_v2 (
  cycle_id         INTEGER NOT NULL,
  scope            VARCHAR NOT NULL,
  member_rel_path  VARCHAR NOT NULL,
  member           VARCHAR NOT NULL,
  position         INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, scope, member_rel_path, member)
);

INSERT OR IGNORE INTO cg_symbols_cycles_v2 (cycle_id, scope, member_rel_path, member, position)
SELECT cycle_id, scope, CASE WHEN scope = 'file' THEN member ELSE '' END, member, position
  FROM cg_symbols_cycles;

DROP TABLE cg_symbols_cycles;

ALTER TABLE cg_symbols_cycles_v2 RENAME TO cg_symbols_cycles;

CREATE TABLE IF NOT EXISTS cg_symbols_metrics_v2 (
  rel_path   VARCHAR NOT NULL,
  symbol_id  VARCHAR NOT NULL,
  page_rank  DOUBLE NOT NULL,
  PRIMARY KEY (rel_path, symbol_id)
);

INSERT OR IGNORE INTO cg_symbols_metrics_v2 (rel_path, symbol_id, page_rank)
SELECT '', symbol_id, page_rank
  FROM cg_symbols_metrics;

DROP TABLE cg_symbols_metrics;

ALTER TABLE cg_symbols_metrics_v2 RENAME TO cg_symbols_metrics;
