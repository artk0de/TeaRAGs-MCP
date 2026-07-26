-- Codegraph schema — no-in-project-def resolve bucket (inProjectEdgeRecall).
-- Of the unresolved calls in each (language, receiver-kind) bucket, how many
-- have NO in-project definition for their member short-name. Excluded from the
-- inProjectEdgeRecall denominator. Existing rows default to 0.
-- Mirrors 011-cg-run-stats-no-in-project-def.ts — keep in sync.
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS no_in_project_def INTEGER DEFAULT 0;
