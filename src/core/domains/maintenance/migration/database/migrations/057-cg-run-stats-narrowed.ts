/**
 * Codegraph schema — residual receiver narrowing counters (bd tea-rags-mcp-2m83f.43).
 *
 * `narrowed` counts residual sites whose receiver's constraint set settled them
 * to one target, written as a static edge (a subset of `resolved`);
 * `narrow_empty` counts residual sites whose constraint set intersected to no
 * project class. Both on the run breakdown and on the per-file tally it sums
 * from, so prime reads them whichever table serves a language.
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN; DEFAULT 0 backfills existing
 * rows, which reads as "this run narrowed nothing" — correct for a row written
 * before narrowing existed.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_057_CG_RUN_STATS_NARROWED = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS narrowed BIGINT DEFAULT 0;
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS narrow_empty BIGINT DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS narrowed INTEGER DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS narrow_empty INTEGER DEFAULT 0;
`;
