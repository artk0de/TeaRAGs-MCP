/**
 * Drop the page_rank index that makes replacePageRanks fatal (bd tea-rags-mcp-snbzk).
 *
 * `replacePageRanks` rewrites the whole table each finalize —
 * `DELETE FROM cg_symbols_metrics` then a batched INSERT, in one transaction.
 * On DuckDB 1.5.3 that DELETE aborts against the ART index over the DOUBLE
 * `page_rank` column:
 *
 *   Invalid Input Error: Failed to delete all rows from index.
 *                        Only deleted 0 out of 714 rows.
 *
 * The error is FATAL: it invalidates the database handle for the rest of the
 * process, so everything the run had still to write — `cg_run_stats` among them
 * — is lost, and the index run exits non-zero. That is what made prime's
 * "## Codegraph resolve" section come and go between runs: a run that hit the
 * fatal never persisted its breakdown, the next one ran against a restarted
 * handle and did. Observed live on the tea-rags self-index 2026-08-11.
 *
 * The index buys nothing. `page_rank` is never a predicate or a sort key: the
 * readers are a full scan (`method-edge-reader.ts`) and a `WHERE symbol_id = ?`
 * lookup (`graph-analytics-store.ts`), which the PRIMARY KEY already serves.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_018_CG_METRICS_DROP_PAGE_RANK_INDEX = `
DROP INDEX IF EXISTS idx_cg_symbols_metrics_page_rank;
`;
