/**
 * The analytics half of the store: adjacency out, cycles and PageRank back in.
 *
 * The adapter deliberately owns NO algorithm. Tarjan SCC and PageRank run in
 * `domains/trajectory/codegraph/infra/` — per `.claude/rules/domain-boundaries.md`
 * adapters may not import from domains — so this module exposes only the
 * primitives that orchestrator drives: read the adjacency (streamed for the hot
 * path, pre-bucketed for older callers), then atomically replace
 * `cg_symbols_cycles` / `cg_symbols_metrics` with the computed result.
 *
 * The one piece of logic that IS here is cycle path filtering: a `CycleEntry`
 * carries members, not paths, so matching a glob against a method-scope cycle
 * means resolving each symbol back to its file through the edge table.
 */

import picomatch from "picomatch";

import type { CycleEntry, CycleScope, SymbolId } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

export class DuckDbGraphAnalyticsStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    const rows = await this.session.queryAll<{ cycle_id: number | bigint; member: string; position: number | bigint }>(
      "SELECT cycle_id, member, position FROM cg_symbols_cycles WHERE scope = ? ORDER BY cycle_id, position",
      [scope],
    );
    const grouped = new Map<number, string[]>();
    for (const row of rows) {
      const cycleId = Number(row.cycle_id);
      const arr = grouped.get(cycleId);
      if (arr) arr.push(row.member);
      else grouped.set(cycleId, [row.member]);
    }
    const entries = [...grouped.entries()].map(([cycleId, members]) => ({ cycleId, scope, members }));
    if (!pathPattern) return entries;
    return this.filterCyclesByPath(entries, scope, pathPattern);
  }

  /**
   * Keep a cycle iff AT LEAST ONE of its members resolves to a file path
   * matching `pathPattern`. The "at least one" semantics is deliberate:
   * cycles that cross a scope boundary (one member inside, one outside)
   * are usually the most interesting and must NOT be silently dropped by
   * a stricter "all members match" rule.
   *
   * File scope: a member IS the rel_path → match directly. Method scope:
   * a member is a symbol id; its file path is resolved from the method
   * edge table (source/target rel_path), since `cg_symbols` is only
   * populated by `upsertSymbols`, not by every `upsertFile`.
   */
  private async filterCyclesByPath(
    entries: CycleEntry[],
    scope: CycleScope,
    pathPattern: string,
  ): Promise<CycleEntry[]> {
    const isMatch = picomatch(pathPattern);
    if (scope === "file") {
      return entries.filter((e) => e.members.some((member) => isMatch(member)));
    }
    const symbolToPaths = await this.resolveMethodSymbolPaths(entries.flatMap((e) => e.members));
    return entries.filter((e) => e.members.some((member) => (symbolToPaths.get(member) ?? []).some((p) => isMatch(p))));
  }

  /**
   * Map each given method symbol id to the file path(s) it appears in,
   * read from the method-edge table. Bounded by the cycle membership set
   * via an `IN (…)` filter so the scan never widens to the whole graph.
   */
  private async resolveMethodSymbolPaths(symbolIds: readonly string[]): Promise<Map<string, string[]>> {
    const map = new Map<string, string[]>();
    const unique = [...new Set(symbolIds)];
    if (unique.length === 0) return map;
    const placeholders = unique.map(() => "?").join(", ");
    const rows = await this.session.queryAll<{ sym: string; path: string }>(
      `SELECT source_symbol_id AS sym, source_rel_path AS path FROM cg_symbols_edges_method WHERE source_symbol_id IN (${placeholders})
       UNION
       SELECT target_symbol_id AS sym, target_rel_path AS path FROM cg_symbols_edges_method WHERE target_symbol_id IN (${placeholders})`,
      [...unique, ...unique],
    );
    for (const row of rows) {
      const paths = map.get(row.sym);
      if (paths) paths.push(row.path);
      else map.set(row.sym, [row.path]);
    }
    return map;
  }

  /**
   * Stream the adjacency for the requested scope as `[source, target]`
   * pairs, fetched from DuckDB one result chunk (~2048 rows) at a time.
   *
   * Method scope additionally carries the per-edge dispatch confidence as a
   * third tuple element (bd tea-rags-mcp-s5ato) — legacy NULL rows coalesce
   * to 1.0 — so the SCC/PageRank consumers can weight dynamic/cone fan-out
   * edges without a second table pass. File edges have no confidence column;
   * the file scope keeps yielding plain `[source, target]` pairs (weight
   * defaults to 1 downstream).
   *
   * TRUE streaming via `connection.stream` + `DuckDBResult.fetchChunk`: only
   * one chunk's rows are resident in JS at any moment. The prior
   * implementation routed through `queryAll` →
   * `runAndReadAll().getRowObjectsJson()`, which materialised the ENTIRE
   * `cg_symbols_edges_method` table into one JS array up front — on a large
   * repo that whole-table copy (alongside the caller's adjacency `Map` and
   * Tarjan/PageRank working sets) was a multi-GB peak and a contributor to the
   * codegraph OOM. Chunked fetch keeps the read half bounded.
   */
  async *streamAdjacency(scope: CycleScope): AsyncIterableIterator<[source: string, target: string, weight?: number]> {
    const sql =
      scope === "file"
        ? "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file"
        : "SELECT source_symbol_id, target_symbol_id, COALESCE(confidence, 1.0) FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL";
    for await (const row of this.session.streamRows(sql)) {
      const source = row[0];
      const target = row[1];
      // Defensive: WHERE already excludes null targets for method scope, but
      // keep the guard so a null can never become the string "null".
      if (source === null || source === undefined || target === null || target === undefined) continue;
      if (scope === "file") {
        yield [String(source), String(target)];
      } else {
        const weight = row[2];
        yield [String(source), String(target), weight === null || weight === undefined ? 1 : Number(weight)];
      }
    }
  }

  /**
   * Materialise the adjacency map for the requested scope from the
   * appropriate edge table. For file scope, vertices are relPath; for
   * method scope, vertices are symbolId. Method edges with null
   * target_symbol_id (resolver couldn't pin the call) are skipped —
   * phantom edges pollute graph algorithms downstream.
   *
   * Pure read. Domain orchestrator owns the algorithm (Tarjan,
   * PageRank, …) and calls `replaceCycles` / `replacePageRanks` to
   * persist back. This keeps adapter at the CRUD layer.
   *
   * Kept for backward-compatibility with callers that want the
   * pre-bucketed Map; new callers should prefer `streamAdjacency` and
   * decide their own representation.
   */
  async listAdjacency(scope: CycleScope): Promise<Map<string, string[]>> {
    if (scope === "file") {
      const rows = await this.session.queryAll<{ source_rel_path: string; target_rel_path: string }>(
        "SELECT source_rel_path, target_rel_path FROM cg_symbols_edges_file",
      );
      const adj = new Map<string, string[]>();
      for (const row of rows) {
        const list = adj.get(row.source_rel_path);
        if (list) list.push(row.target_rel_path);
        else adj.set(row.source_rel_path, [row.target_rel_path]);
      }
      return adj;
    }
    const rows = await this.session.queryAll<{ source_symbol_id: string; target_symbol_id: string | null }>(
      "SELECT source_symbol_id, target_symbol_id FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL",
    );
    const adj = new Map<string, string[]>();
    for (const row of rows) {
      if (row.target_symbol_id === null) continue;
      const list = adj.get(row.source_symbol_id);
      if (list) list.push(row.target_symbol_id);
      else adj.set(row.source_symbol_id, [row.target_symbol_id]);
    }
    return adj;
  }

  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_symbols_cycles WHERE scope = ?", [scope]);
      const rows: unknown[][] = [];
      for (let cycleId = 0; cycleId < sccs.length; cycleId++) {
        const members = sccs[cycleId];
        for (let position = 0; position < members.length; position++) {
          rows.push([cycleId, scope, members[position], position]);
        }
      }
      await this.session.insertBatched("cg_symbols_cycles", ["cycle_id", "scope", "member", "position"], rows);
    });
  }

  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.session.transaction(async () => {
      await this.session.exec("DELETE FROM cg_symbols_metrics");
      const rows = [...ranks].map(([symbolId, rank]) => [symbolId, String(rank)]);
      await this.session.insertBatched("cg_symbols_metrics", ["symbol_id", "page_rank"], rows);
    });
  }

  async getPageRank(symbolId: SymbolId): Promise<number> {
    const rows = await this.session.queryAll<{ page_rank: number | bigint | string }>(
      "SELECT page_rank FROM cg_symbols_metrics WHERE symbol_id = ?",
      [symbolId],
    );
    const raw = rows[0]?.page_rank;
    return raw === undefined ? 0 : Number(raw);
  }
}
