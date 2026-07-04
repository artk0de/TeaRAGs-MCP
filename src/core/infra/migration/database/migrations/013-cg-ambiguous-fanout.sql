-- Codegraph ambiguous dispatch fan-out aggregate (bd tea-rags-mcp-f2jsb / j0pki).
--
-- An over-cap dynamic fan-out (survivors > corpus-adaptive DispatchFanoutPolicy
-- cap) is recorded as ONE aggregate row instead of m noise edges — `#firm`
-- defined in 240 multi-tenant models flooded taxdome with 1.5M edges and made
-- enrichment non-terminating. The aggregate keeps recall reporting honest:
-- strict inProjectEdgeRecall counts the call as a miss, coveredRecall counts
-- the aggregate as coverage.
--
-- PK (source_symbol_id, call_expression) = aggregate-existence semantics, not
-- occurrence count. Per-file DELETE+INSERT lifecycle keyed by source_rel_path,
-- same as the edge tables.
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
-- Run-stats bucket: per (language, receiver-kind), how many unresolved calls
-- were over-cap ambiguous. Its own bucket — NOT a genuine miss, NOT external.
-- DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
-- supported"); DEFAULT 0 alone backfills existing rows and new inserts.
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS ambiguous_fanout INTEGER DEFAULT 0;
