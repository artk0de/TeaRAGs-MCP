/**
 * Previous-run signal baseline (`cg_symbol_signals_prev` / `cg_file_signals_prev`,
 * migration 023) and the diff against it — bd tea-rags-mcp-a2ddb.
 *
 * Every other derived table here is a wholesale recompute that self-corrects.
 * The Qdrant payload built from those tables is not: it was rewritten only for
 * the files in a run's chunk map, so a file that stopped changing kept the
 * fanIn / fanOut / pageRank it had when it last changed. These two tables are
 * what lets the run tell "moved" from "unchanged" without re-reading every
 * point: the baseline is written at the END of a successful heal, and the next
 * run diffs the fresh graph against it.
 *
 * The two halves are deliberately NOT symmetrical, because the two signals are
 * not: chunk fan is the confidence-weighted `SUM(COALESCE(confidence, 1.0))`
 * that `getChunkSignalsBulk` writes into the payload (bd tea-rags-mcp-s5ato),
 * keyed by `symbol_id` ALONE; file fan is a plain COUNT over
 * `cg_symbols_edges_file`, keyed by path. Diffing anything but the expression
 * the payload is built from produces a diff that is right about edges and wrong
 * about signals — an edge COUNT, for instance, misses a dispatch-confidence
 * change that moves fanIn from 1 to 0.25.
 *
 * Who drives the refresh, and why `transitiveImpact` / `isHub` sit outside the
 * comparison: `src/core/domains/trajectory/codegraph/CLAUDE.md`.
 */

import type { CodegraphSignalDrift, RelPath, SymbolId } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

/**
 * Current per-symbol signals, expressed exactly as
 * `DuckDbMethodEdgeReader#getChunkSignalsBulk` expresses them, projected onto
 * the `(rel_path, symbol_id)` identity of `cg_symbols` — the payload is written
 * per FILE's points, so the diff has to name the file as well as the symbol.
 *
 * `round(…, 2)` mirrors `roundEdgeWeightSum`: the `confidence` column is REAL
 * and SUM accumulates in DOUBLE, so three 1/3-confidence edges land on
 * 1.0000000298… Without the rounding every run would diff against float noise
 * and heal the whole corpus forever.
 */
const CURRENT_SYMBOL_SIGNALS = `
  WITH fi AS (
    SELECT target_symbol_id AS symbol_id, round(SUM(COALESCE(confidence, 1.0)), 2) AS fan_in
    FROM cg_symbols_edges_method
    WHERE target_symbol_id IS NOT NULL
    GROUP BY 1
  ), fo AS (
    SELECT source_symbol_id AS symbol_id, round(SUM(COALESCE(confidence, 1.0)), 2) AS fan_out
    FROM cg_symbols_edges_method
    GROUP BY 1
  ), cur AS (
    SELECT s.rel_path,
           s.symbol_id,
           COALESCE(fi.fan_in, 0)   AS fan_in,
           COALESCE(fo.fan_out, 0)  AS fan_out,
           COALESCE(m.page_rank, 0) AS page_rank
    FROM cg_symbols s
    LEFT JOIN fi ON fi.symbol_id = s.symbol_id
    LEFT JOIN fo ON fo.symbol_id = s.symbol_id
    LEFT JOIN cg_symbols_metrics m ON m.symbol_id = s.symbol_id
  )`;

/**
 * Current per-file signals — the file universe is `cg_symbols_files` (every
 * walked file, including ones with no edges at all), LEFT JOINed against the
 * per-direction edge counts, which is the same shape `getFileMetricsBulk` reads.
 *
 * `transitiveImpact` and `isHub` are deliberately NOT part of the identity: the
 * first is a depth-5 reverse BFS that would have to be recomputed for the whole
 * corpus to diff, and the second is a comparison against a collection-wide p95
 * that moves for every file at once. Both are healed for the files this diff
 * DOES name, and both stay as they were for the rest until the next
 * `--force-enrichments codegraph`.
 */
const CURRENT_FILE_SIGNALS = `
  WITH ffi AS (
    SELECT target_rel_path AS rel_path, COUNT(*) AS fan_in
    FROM cg_symbols_edges_file
    GROUP BY 1
  ), ffo AS (
    SELECT source_rel_path AS rel_path, COUNT(*) AS fan_out
    FROM cg_symbols_edges_file
    GROUP BY 1
  ), cur AS (
    SELECT f.rel_path,
           COALESCE(ffi.fan_in, 0)  AS fan_in,
           COALESCE(ffo.fan_out, 0) AS fan_out
    FROM cg_symbols_files f
    LEFT JOIN ffi ON ffi.rel_path = f.rel_path
    LEFT JOIN ffo ON ffo.rel_path = f.rel_path
  )`;

/**
 * PageRank is a normalised DOUBLE whose realistic values sit at 1e-4..1e-1, so
 * the comparison needs an epsilon well below the smallest meaningful move and
 * well above DOUBLE round-trip noise. 1e-12 is both.
 */
const PAGE_RANK_EPSILON = "1e-12";

export class DuckDbSignalDriftStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /**
   * Symbols and files whose derived signals differ from the baseline the last
   * successful heal recorded. A row absent from the baseline counts as moved —
   * which is what makes the first run after migration 023 heal every point
   * once, with no extraction and no embeddings.
   *
   * Rows that vanished from the graph are NOT reported: their Qdrant points went
   * with the file, and `refreshSymbolSignalsPrev` replaces the baseline wholesale
   * so they never accumulate.
   */
  async diffSymbolSignals(): Promise<CodegraphSignalDrift> {
    const symbols = await this.session.queryAll<{ rel_path: RelPath; symbol_id: SymbolId }>(
      `${CURRENT_SYMBOL_SIGNALS}
       SELECT cur.rel_path, cur.symbol_id
       FROM cur
       LEFT JOIN cg_symbol_signals_prev p ON p.rel_path = cur.rel_path AND p.symbol_id = cur.symbol_id
       WHERE p.symbol_id IS NULL
          OR cur.fan_in <> p.fan_in
          OR cur.fan_out <> p.fan_out
          OR abs(cur.page_rank - p.page_rank) > ${PAGE_RANK_EPSILON}`,
    );
    const files = await this.session.queryAll<{ rel_path: RelPath }>(
      `${CURRENT_FILE_SIGNALS}
       SELECT cur.rel_path
       FROM cur
       LEFT JOIN cg_file_signals_prev p ON p.rel_path = cur.rel_path
       WHERE p.rel_path IS NULL
          OR cur.fan_in <> p.fan_in
          OR cur.fan_out <> p.fan_out`,
    );
    return {
      symbols: symbols.map((r) => ({ relPath: r.rel_path, symbolId: r.symbol_id })),
      files: files.map((r) => ({ relPath: r.rel_path })),
    };
  }

  /**
   * Record the current signals as the baseline for the next run. Called by the
   * coordinator AFTER a successful heal, never by the finalizer: refreshing it
   * before the payload is rewritten would erase the diff a failed heal has to
   * retry, and the drift would then be invisible until the file changed again.
   *
   * Both tables are replaced inside ONE transaction. A half-refreshed baseline
   * is worse than a stale one — the symbol half would read "healed" while the
   * file half still asks to be.
   */
  async refreshSymbolSignalsPrev(): Promise<void> {
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_symbol_signals_prev");
      await this.session.run(
        `${CURRENT_SYMBOL_SIGNALS}
         INSERT INTO cg_symbol_signals_prev (rel_path, symbol_id, fan_in, fan_out, page_rank)
         SELECT rel_path, symbol_id, fan_in, fan_out, page_rank FROM cur`,
      );
      await this.session.run("DELETE FROM cg_file_signals_prev");
      await this.session.run(
        `${CURRENT_FILE_SIGNALS}
         INSERT INTO cg_file_signals_prev (rel_path, fan_in, fan_out)
         SELECT rel_path, fan_in, fan_out FROM cur`,
      );
    });
  }
}
