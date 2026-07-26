CREATE TABLE IF NOT EXISTS cg_symbols_cycles (
  cycle_id    INTEGER NOT NULL,
  scope       VARCHAR NOT NULL,
  member      VARCHAR NOT NULL,
  position    INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, scope, member)
);

CREATE INDEX IF NOT EXISTS idx_cg_symbols_cycles_scope ON cg_symbols_cycles (scope);
CREATE INDEX IF NOT EXISTS idx_cg_symbols_cycles_member ON cg_symbols_cycles (member);
