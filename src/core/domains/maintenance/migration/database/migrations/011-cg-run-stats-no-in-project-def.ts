/**
 * Codegraph schema — no-in-project-def resolve bucket (inProjectEdgeRecall).
 *
 * Adds `no_in_project_def` to `cg_run_stats`: of the unresolved calls in each
 * (language, receiver-kind) bucket, how many have NO in-project definition for
 * their member short-name (gem/core/runtime-generated/dynamic). These can never
 * produce an in-project edge, so they are excluded from the inProjectEdgeRecall
 * denominator — recall then measures graph completeness over calls that COULD
 * resolve to a project symbol. Existing rows default to 0 (idempotent ADD COLUMN
 * IF NOT EXISTS), which collapses recall back to raw capability until the next
 * re-index repopulates the column.
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
 * supported"); DEFAULT 0 alone backfills existing rows and new inserts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_011_CG_RUN_STATS_NO_IN_PROJECT_DEF = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS no_in_project_def INTEGER DEFAULT 0;
`;
