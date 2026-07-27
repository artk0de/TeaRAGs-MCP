-- Codegraph schema — core-homonym resolve bucket (bd tea-rags-mcp-83cl7).
-- Of the unresolved calls in each (language, receiver-kind) bucket, how many are
-- a CORE/runtime member (`each`, `to_s`, `first`) on an UNTYPED receiver whose
-- in-project def of the same short name is a coincidence. Excluded from the
-- inProjectEdgeRecall denominator. Existing rows default to 0.
-- Mirrors 015-cg-run-stats-core-ambiguous.ts — keep in sync.
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS core_ambiguous INTEGER DEFAULT 0;
