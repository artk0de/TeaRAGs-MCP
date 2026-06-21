/**
 * Codegraph schema — per-language resolve grain (bd tea-rags-mcp-cnqrg).
 *
 * Re-grains `cg_run_stats` from per-receiver-kind to per-(language,
 * receiver_kind) so `get_index_status` can break `resolveSuccessRate` down per
 * code language and locate the resolver gap. The single-column `receiver_kind`
 * PRIMARY KEY rejects two languages sharing a kind (e.g. (typescript, constant)
 * + (ruby, constant)), so the table is recreated with a composite PRIMARY KEY.
 *
 * `cg_run_stats` is a transient per-run cache — `recordRunStats` rewrites the
 * whole table every enrichment run — so DROP loses nothing; the next run
 * repopulates it. DuckDB cannot ALTER a PRIMARY KEY in place, hence DROP+CREATE.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_009_CG_RUN_STATS_LANGUAGE = `
DROP TABLE IF EXISTS cg_run_stats;
CREATE TABLE IF NOT EXISTS cg_run_stats (
  language         VARCHAR NOT NULL DEFAULT '',
  receiver_kind    VARCHAR NOT NULL,
  attempted        INTEGER NOT NULL,
  resolved         INTEGER NOT NULL,
  external_skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (language, receiver_kind)
);
`;
