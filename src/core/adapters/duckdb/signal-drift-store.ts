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
 *
 * `chunk_id` rides along because the DIFF needs it and the baseline does not:
 * `cur` is already reading `cg_symbols`, so projecting one more column is free,
 * while a second join to test it would not be. The baseline INSERT names its
 * columns explicitly and simply ignores it.
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
           s.chunk_id,
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
 * The diff universe is what is MATERIALIZED in Qdrant, not what is in the graph
 * (bd tea-rags-mcp-85xha), and `cg_symbols.chunk_id` is the graph's own record
 * of which symbols reached a point: the deferred chunk pass is its only writer,
 * it REPLACES the column per file it names, and it runs BEFORE the heal in the
 * same completion tail — so at diff time the column is as fresh as the run's
 * chunk map. This clause is the FILE half; the symbol half is `chunk_id` on the
 * row itself, projected by `CURRENT_SYMBOL_SIGNALS`.
 *
 * A file is named when ANY one of its symbols is mapped, because the heal writes
 * the file level onto EVERY point of the file rather than per symbol.
 *
 * Without the predicate the diff is over the whole graph, and the graph is wider
 * than the index: a file the extractor walked but the chunk pass never matched
 * to a point re-enters the diff on every fan change, forever. Measured on
 * taxdome right after a `--force-enrichments codegraph` recompute: 218 such
 * files, 218 exact scrolls, 0 points rewritten, 9.8 s — plus the bulk graph
 * reads `createSignalBuilders` paid for those paths.
 *
 * The disjunct is what keeps the predicate from over-narrowing. `chunk_id` can
 * only speak for files that HAVE symbols; a barrel of `export *`, or a script
 * that is all top-level statements, walks into `cg_symbols_files` with edges and
 * Qdrant points and no symbol row to carry the marker. Excluding those would let
 * their `codegraph.symbols.file.*` block go stale for good — the very defect
 * migration 023 exists to close — so they stay in. What that readmits is the
 * subset of them that have no points either, and there is no marker in the graph
 * that separates the two; they are a bounded residual, not the 218-file case,
 * which is symbol-BEARING files whose symbols are all unmapped.
 */
const FILE_MAY_HAVE_POINTS = `(EXISTS (
         SELECT 1 FROM cg_symbols s
         WHERE s.rel_path = cur.rel_path AND s.chunk_id IS NOT NULL
       )
       -- Kept: a file with no symbol rows (barrel, top-level-only script) has points
       -- and file fan but nothing to map; the point-less ones are a bounded residual.
       OR NOT EXISTS (SELECT 1 FROM cg_symbols s WHERE s.rel_path = cur.rel_path))`;

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
   * successful heal recorded, RESTRICTED to the ones that have a Qdrant point to
   * rewrite (see `FILE_MAY_HAVE_POINTS`). A row absent from the baseline
   * counts as moved — which is what makes the first run after migration 023 heal
   * every materialized point once, with no extraction and no embeddings.
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
       WHERE cur.chunk_id IS NOT NULL
         AND (p.symbol_id IS NULL
           OR cur.fan_in <> p.fan_in
           OR cur.fan_out <> p.fan_out
           OR abs(cur.page_rank - p.page_rank) > ${PAGE_RANK_EPSILON})`,
    );
    const files = await this.session.queryAll<{ rel_path: RelPath }>(
      `${CURRENT_FILE_SIGNALS}
       SELECT cur.rel_path
       FROM cur
       LEFT JOIN cg_file_signals_prev p ON p.rel_path = cur.rel_path
       WHERE ${FILE_MAY_HAVE_POINTS}
         AND (p.rel_path IS NULL
           OR cur.fan_in <> p.fan_in
           OR cur.fan_out <> p.fan_out)`,
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
   *
   * WHOLESALE on purpose, while `diffSymbolSignals` is filtered to what has a
   * point: the baseline records the unmapped rows too, so a file that LATER
   * gains points is compared against real values rather than re-entering as
   * "absent from baseline". Nothing is lost by that — the run that gives a file
   * its points is the run that CHUNKED it, so the applier has already rewritten
   * its payload and the heal receives it in `skipRelPaths`; every move AFTER
   * that is diffed normally. Filtering here instead would make the baseline
   * forget those rows and heal them once for nothing.
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
