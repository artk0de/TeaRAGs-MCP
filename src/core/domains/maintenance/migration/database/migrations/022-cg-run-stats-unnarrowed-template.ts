/**
 * Codegraph schema — the unnarrowed-self-dispatch-entry invariant on
 * `cg_run_stats` (bd tea-rags-mcp-znxg8).
 *
 * Every other counter on this table describes a MISS, and every rate built from
 * them measures how much the resolver could not reach. That is exactly why none
 * of them saw znxg8: the degraded edges all RESOLVED. A concrete
 * `SomeService.call(...)` landing on the shared `KindOfService.call` it inherits
 * is a wrong target, not a missing one, so `inProjectEdgeRecall` read 1.0 while
 * 200 of 200 sampled caller edges of that node were entry calls that should
 * never have been there.
 *
 * This column counts them directly: resolved calls whose target is a shared
 * self-dispatch entry node. It feeds no rate — it is an invariant that sits near
 * zero when entry narrowing works, and it is the only thing on this table that
 * would have made the regression visible while it was happening.
 *
 * DuckDB rejects NOT NULL on ALTER ... ADD COLUMN; DEFAULT 0 backfills existing
 * rows, which reads as "this run measured nothing" — correct for a row written
 * before the counter existed.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_022_CG_RUN_STATS_UNNARROWED_TEMPLATE = `
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS unnarrowed_template BIGINT DEFAULT 0;
`;
