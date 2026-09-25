/**
 * Persisted "derived tables are stale" mark (bd tea-rags-mcp-dy852).
 *
 * `cg_symbols_cycles` / `cg_symbols_metrics` are wholesale recomputes that run
 * at the end of every enrichment run — except a deletion-only reindex, which
 * takes a fast path that opens no run. Recomputing there means a whole-graph
 * Tarjan SCC + PageRank per deleted file batch, so the deletion instead PRUNES
 * the derived rows it invalidated (cycles with a member in a deleted file, that
 * file's ranks) and records here that the rest are stale: every remaining rank
 * was computed over a graph that still held the deleted nodes.
 *
 * The mark is a row, not a flag column on another table, because it outlives
 * the process that set it — the recompute that clears it runs on the NEXT
 * reindex, which may be a different process (MCP vs CLI) against a daemon that
 * restarted in between. `replacePageRanks`, the last write of every full
 * recompute, deletes it in the same transaction.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_029_CG_DERIVED_STALE = `
CREATE TABLE IF NOT EXISTS cg_derived_stale (
  marker     VARCHAR PRIMARY KEY,
  marked_at  TIMESTAMP NOT NULL DEFAULT current_timestamp
);
`;
