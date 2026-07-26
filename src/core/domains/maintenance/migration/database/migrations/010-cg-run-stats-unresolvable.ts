/**
 * Codegraph schema — unresolvable resolve bucket (bd cai0).
 *
 * Adds `unresolvable` to `cg_run_stats`: of the unresolved calls in each
 * (language, receiver-kind) bucket, how many were statically UNDETERMINABLE —
 * dynamic `send(var)` / `public_send(expr)` with a non-literal target — rather
 * than resolver misses. Excluded from the resolveSuccessRate denominator
 * alongside `external_skipped`, so the rate measures the resolver's capability
 * on STATICALLY-DETERMINABLE calls. Existing rows default to 0 (idempotent ADD
 * COLUMN IF NOT EXISTS).
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN ("constraints not yet
 * supported"); DEFAULT 0 alone backfills existing rows and new inserts.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_010_CG_RUN_STATS_UNRESOLVABLE = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS unresolvable INTEGER DEFAULT 0;
`;
