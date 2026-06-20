/**
 * Codegraph schema — external-skipped resolve bucket (bd tea-rags-mcp-ykj7).
 *
 * Adds `external_skipped` to `cg_run_stats`: of the unresolved calls in each
 * receiver-kind bucket, how many the language resolver classified as targeting
 * an external library / runtime import (`Math.max`, `fs.readFile`,
 * `Net::HTTP.get`). Excluded from the resolveSuccessRate denominator so the
 * persisted breakdown reflects PROJECT-INTERNAL resolver capability. Existing
 * rows default to 0 (idempotent ADD COLUMN IF NOT EXISTS).
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
 * supported"); DEFAULT 0 alone backfills existing rows and new inserts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_008_CG_RUN_STATS_EXTERNAL = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS external_skipped INTEGER DEFAULT 0;
`;
