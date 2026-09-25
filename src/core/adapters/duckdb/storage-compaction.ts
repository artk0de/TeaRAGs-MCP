/**
 * When a codegraph DuckDB file is worth compacting (bd tea-rags-mcp-dvzdm).
 *
 * DuckDB 1.5.3 reclaims deleted rows at CHECKPOINT only for tables that carry
 * no index. Every `cg_*` table has a PRIMARY KEY, so every row an incremental
 * reindex deletes stays in the file for good: measured on a scratch copy, a
 * PK table that is DELETE-all + re-INSERTed eight times holds nine generations
 * (`estimated_size` 540,000 for 60,000 live rows), the same table without the
 * key stays at 60,000. The taxdome graph had reached 1.22 GB for 287 MB of
 * live data. The wholesale tables avoid it by being recreated
 * (`DuckDbGraphSession#recreateEmptyTable`); the tables diffed per changed
 * file cannot, and are reclaimed by rewriting the whole file
 * (`DuckDbGraphSession#compactDatabaseFile`).
 *
 * The signal is `duckdb_tables().estimated_size` summed over the tables against
 * `count(*)` summed over the same tables. The estimate counts every row version
 * the table's row groups still hold, deleted ones included, and drops back to
 * the live count once a table is rebuilt — so the ratio IS the dead-version
 * ratio the file carries, read from the catalog plus one count per table
 * (15 ms on taxdome). Block counts would be the byte-accurate alternative, but
 * the used-block total cannot tell a dead row group from a live one, and a
 * compacted estimate to compare it against costs the compaction itself.
 */

import type { CodegraphStorageFootprint } from "../../contracts/types/codegraph.js";

export interface CodegraphCompactionPolicy {
  /**
   * Files smaller than this are never compacted, however much of them is dead:
   * a small project's whole graph costs less to keep than the rewrite does.
   */
  minFileBytes: number;
  /** Compact once stored row versions reach this multiple of the live rows. */
  minStoredToLiveRatio: number;
}

/**
 * 64 MiB and "at least half of the stored versions are dead". A rewrite reads
 * the live rows once and writes them once — taxdome's 1.22 GB file compacted to
 * 287 MB in 3.8 s — so the floor keeps it off every small graph, and the ratio
 * keeps a file that grows by live data from being rewritten for nothing.
 */
export const DEFAULT_CODEGRAPH_COMPACTION_POLICY: CodegraphCompactionPolicy = {
  minFileBytes: 64 * 1024 * 1024,
  minStoredToLiveRatio: 2,
};

/** Whether a store with this footprint should be compacted now. */
export function shouldCompactCodegraphStorage(
  footprint: CodegraphStorageFootprint,
  policy: CodegraphCompactionPolicy = DEFAULT_CODEGRAPH_COMPACTION_POLICY,
): boolean {
  if (footprint.fileBytes < policy.minFileBytes) return false;
  // Nothing dead at all: not even an empty store is worth rewriting.
  if (footprint.storedRows <= footprint.liveRows) return false;
  return footprint.storedRows >= policy.minStoredToLiveRatio * footprint.liveRows;
}
