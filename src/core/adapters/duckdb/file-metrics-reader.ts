/**
 * File-level graph metrics derived from the import edge table: direct fanIn /
 * fanOut, the collection-wide fanIn p95 that decides `isHub`, and the bounded
 * reverse-BFS blast radius.
 *
 * Pure reads, no transaction — separated from `DuckDbFileGraphStore` because
 * these never touch the file rows themselves, they only count edges pointing at
 * them. Two of the queries inline a sanitised integer instead of binding it;
 * both say why at the call site.
 */

import type { FileGraphMetrics, RelPath } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

export class DuckDbFileMetricsReader {
  constructor(private readonly session: DuckDbGraphSession) {}

  async getFanIn(relPath: RelPath): Promise<number> {
    const rows = await this.session.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE target_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getFanOut(relPath: RelPath): Promise<number> {
    const rows = await this.session.queryAll<{ n: number }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_edges_file WHERE source_rel_path = ?",
      [relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  async getFanInP95(): Promise<number> {
    // Per-file fanIn = COUNT of edges whose target is that file — the same
    // metric `getFanIn(relPath)` returns for one file. The percentile is
    // taken over the FULL file universe (cg_symbols_files), LEFT JOINed
    // against per-target edge counts so files with zero incoming edges
    // contribute fanIn=0 to the distribution. A hub is relative to ALL
    // files (including leaves), so the zero-fanIn tail must be present.
    //
    // Anchoring on cg_symbols_files (not on the edge table's distinct
    // targets) is what makes this correct under incremental reindex: the
    // first pass has already brought the whole graph up to date, and this
    // query reads the entire collection rather than the changed-file
    // subset the overlay loop iterates.
    //
    // PERCENTILE_CONT yields NULL on an empty universe (no files) — COALESCE
    // to 0 so the caller's `fanIn > p95` comparison degenerates sanely.
    const rows = await this.session.queryAll<{ p95: number | null }>(
      `WITH file_fan_in AS (
         SELECT f.rel_path AS rel_path, COUNT(e.source_rel_path) AS fan_in
         FROM cg_symbols_files f
         LEFT JOIN cg_symbols_edges_file e ON e.target_rel_path = f.rel_path
         GROUP BY f.rel_path
       )
       SELECT COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY fan_in), 0) AS p95
       FROM file_fan_in`,
    );
    return Number(rows[0]?.p95 ?? 0);
  }

  async getTransitiveImpact(relPath: RelPath, maxDepth = 5): Promise<number> {
    // Reverse BFS via DuckDB recursive CTE. Seed = files that directly
    // import `relPath`; each round walks one edge further. UNION (vs
    // UNION ALL) deduplicates so each ancestor is counted once even
    // when reached via multiple paths. The depth cap keeps cost
    // predictable on large repos (depth 5 captures most realistic
    // blast radii without exploding on hub files).
    //
    // safeDepth is INLINED rather than bound: bindParams in this adapter
    // binds every value via bindVarchar (driver constraint — see
    // `bindVarchar non-nullable in @duckdb/node-api 1.5.x` note in
    // adapter docs). DuckDB compares varchar against integer with
    // implicit casts that produce surprising results, so the integer
    // comparison `i.depth < N` must stay literal. The value is
    // sanitised to a small positive integer before substitution, so
    // injection is structurally impossible.
    const safeDepth = Math.max(1, Math.floor(maxDepth));
    // The final WHERE filters the file itself out of the count: in a
    // cyclic dependency graph (A imports B imports A) the recursive
    // walk circles back to the source, but a file is not part of its
    // own blast radius. UNION already ensures each path appears once.
    const rows = await this.session.queryAll<{ n: number | bigint }>(
      `WITH RECURSIVE impact(rel_path, depth) AS (
         SELECT source_rel_path, 1
         FROM cg_symbols_edges_file
         WHERE target_rel_path = ?
         UNION
         SELECT e.source_rel_path, i.depth + 1
         FROM cg_symbols_edges_file e
         JOIN impact i ON e.target_rel_path = i.rel_path
         WHERE i.depth < ${safeDepth}
       )
       SELECT COUNT(DISTINCT rel_path) AS n FROM impact WHERE rel_path != ?`,
      [relPath, relPath],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Setwise form of `getFanIn` + `getFanOut` + `getTransitiveImpact` over a set
   * of roots (bd tea-rags-mcp-6aytq). THREE statements per call whatever the
   * set size, replacing the `3 × fileCount` point queries the finalize overlay
   * read-back used to issue — 31,863 of them over a real taxdome graph's 10,621
   * TS files, each a daemon round-trip contending with the pass-2 bulk flush
   * for the same single DuckDB connection. Measured on that graph: 30,817 ms
   * per-file against 1,307 ms setwise, same values for every root.
   *
   * The impact walk is the per-file recursive CTE with the root carried through
   * the recursion instead of bound once: the seed emits `(target, importer)`
   * for every requested root at once, and each recursive round joins the whole
   * frontier in one hash join rather than re-planning per root. `UNION`
   * deduplicates on `(root, rel_path, depth)` — the per-root equivalent of the
   * per-file query's `(rel_path, depth)` — so counts stay PER ROOT even when
   * two roots' blast radii overlap, and a cycle that walks back to the seed is
   * dropped by the same `rel_path <> root` filter.
   *
   * A root with no rows in a given direction is absent from that statement's
   * result and reads as 0, matching the getters. Roots absent from all three
   * never enter the map at all.
   */
  async getFileMetricsBulk(relPaths: readonly RelPath[], maxDepth = 5): Promise<Map<RelPath, FileGraphMetrics>> {
    const out = new Map<RelPath, FileGraphMetrics>();
    if (relPaths.length === 0) return out;
    const entryFor = (relPath: RelPath): FileGraphMetrics => {
      let e = out.get(relPath);
      if (!e) {
        e = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };
        out.set(relPath, e);
      }
      return e;
    };
    // Deduplicate: a repeated root would multiply nothing in SQL (the IN list
    // is a set) but would waste bind slots on a 2k-path batch.
    const roots = [...new Set(relPaths)];
    const placeholders = roots.map(() => "?").join(", ");

    const fanInRows = await this.session.queryAll<{ rel_path: RelPath; n: number | bigint }>(
      `SELECT target_rel_path AS rel_path, COUNT(*) AS n
       FROM cg_symbols_edges_file
       WHERE target_rel_path IN (${placeholders})
       GROUP BY target_rel_path`,
      roots.slice(),
    );
    for (const r of fanInRows) entryFor(r.rel_path).fanIn = Number(r.n ?? 0);

    const fanOutRows = await this.session.queryAll<{ rel_path: RelPath; n: number | bigint }>(
      `SELECT source_rel_path AS rel_path, COUNT(*) AS n
       FROM cg_symbols_edges_file
       WHERE source_rel_path IN (${placeholders})
       GROUP BY source_rel_path`,
      roots.slice(),
    );
    for (const r of fanOutRows) entryFor(r.rel_path).fanOut = Number(r.n ?? 0);

    // safeDepth is INLINED for the same reason as in `getTransitiveImpact`:
    // bindParams binds every value via bindVarchar, and a varchar/integer
    // comparison in the recursion guard casts in surprising ways. Sanitised to
    // a small positive integer, so injection is structurally impossible.
    const safeDepth = Math.max(1, Math.floor(maxDepth));
    const impactRows = await this.session.queryAll<{ root: RelPath; n: number | bigint }>(
      `WITH RECURSIVE impact(root, rel_path, depth) AS (
         SELECT target_rel_path, source_rel_path, 1
         FROM cg_symbols_edges_file
         WHERE target_rel_path IN (${placeholders})
         UNION
         SELECT i.root, e.source_rel_path, i.depth + 1
         FROM cg_symbols_edges_file e
         JOIN impact i ON e.target_rel_path = i.rel_path
         WHERE i.depth < ${safeDepth}
       )
       SELECT root, COUNT(DISTINCT rel_path) AS n
       FROM impact
       WHERE rel_path <> root
       GROUP BY root`,
      roots.slice(),
    );
    for (const r of impactRows) entryFor(r.root).transitiveImpact = Number(r.n ?? 0);

    return out;
  }
}
