
CREATE TABLE IF NOT EXISTS cg_ambiguous_fanout (
  source_symbol_id VARCHAR NOT NULL,
  source_rel_path VARCHAR NOT NULL,
  call_expression VARCHAR NOT NULL,
  member VARCHAR NOT NULL,
  candidate_count INTEGER NOT NULL,
  PRIMARY KEY (source_symbol_id, call_expression)
);
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_source_rel_path ON cg_ambiguous_fanout (source_rel_path);
CREATE INDEX IF NOT EXISTS idx_cg_ambiguous_fanout_member ON cg_ambiguous_fanout (member);
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS ambiguous_fanout INTEGER DEFAULT 0;
