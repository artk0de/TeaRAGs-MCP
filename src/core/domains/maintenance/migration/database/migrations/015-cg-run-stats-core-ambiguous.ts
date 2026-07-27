/**
 * Codegraph schema — core-homonym resolve bucket (bd tea-rags-mcp-83cl7).
 *
 * Adds `core_ambiguous` to `cg_run_stats`: of the unresolved calls in each
 * (language, receiver-kind) bucket, how many are CORE HOMONYMS — a core/runtime
 * member (`each`, `to_s`, `first`, `join`) reached through an UNTYPED receiver,
 * where some project class defines the same short name. The `no_in_project_def`
 * gate cannot see these (the homonym def makes the lookup non-empty), so they
 * were recorded as recall holes they can never be: 4391 of 20964 on taxdome.
 * Excluded from the inProjectEdgeRecall denominator alongside
 * `no_in_project_def`. Existing rows default to 0 (idempotent ADD COLUMN IF NOT
 * EXISTS), which keeps recall at its pre-83cl7 value until the next re-index
 * repopulates the column.
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
 * supported"); DEFAULT 0 alone backfills existing rows and new inserts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_015_CG_RUN_STATS_CORE_AMBIGUOUS = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS core_ambiguous INTEGER DEFAULT 0;
`;
