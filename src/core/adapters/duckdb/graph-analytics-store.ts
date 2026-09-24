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
 * The file dependency graph read (`readFileDependencyGraph`) follows the same
 * split: this module returns edges and call weights, and the boundary
 * diagnostics in `domains/trajectory/codegraph/symbols/boundary-diagnostics/`
 * own the judgement.
 *
 * Method-scope vertices are FILE-SCOPED (bd tea-rags-mcp-4g9ga): a `SymbolId`
 * is unique per file, so the method adjacency is keyed by
 * `fileScopedSymbolKey(relPath, symbolId)` and `replaceCycles` /
 * `replacePageRanks` split that key back into the `(rel_path, symbol_id)` the
 * tables are keyed by (migration 028). The composite key never leaves the
 * stream → algorithm → persist loop; readers see the two columns.
 */

import {
  fileScopedSymbolKey,
  parseFileScopedSymbolKey,
  type CycleEntry,
  type CycleScope,
  type FileDependencyGraph,
  type FileImportLookup,
  type NonPublicMemberEdge,
  type RelPath,
  type SymbolId,
} from "../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../infra/path-pattern.js";
import { decodeFileEdgeExportNames } from "./file-edge-export-names-codec.js";
import type { DuckDbGraphSession } from "./graph-session.js";

/**
 * The files a cycle's members live in — what a `pathPattern` is matched
 * against. A cycle is kept iff AT LEAST ONE member's file matches: cycles that
 * cross a scope boundary are usually the most interesting and must NOT be
 * dropped by a stricter "all members match" rule.
 *
 * The file scope's member IS its path. The method scope reads each member's
 * OWN declaring file off the row, never a name resolution — resolving the bare
 * id `init` back to files answers every file declaring an `init`, which kept a
 * namesake's unrelated cycle under a pattern that names only one of them (bd
 * tea-rags-mcp-4g9ga). A row carried over by migration 028 has no file yet and
 * matches no pattern until the next recompute rewrites it.
 */
function memberPaths(entry: CycleEntry): string[] {
  return entry.memberLocations ? entry.memberLocations.map((m) => m.relativePath) : entry.members;
}

/** `rel_path` of a derived row carried over by migration 028 — its file is unknown. */
const UNKNOWN_REL_PATH = "";

/** Vertex id of a method-scope node: the declaration, not the bare name. */
function methodVertex(relPath: unknown, symbolId: unknown): string {
  return fileScopedSymbolKey({ relPath: String(relPath), symbolId: String(symbolId) });
}

export class DuckDbGraphAnalyticsStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  async findCycles(scope: CycleScope, pathPattern?: string): Promise<CycleEntry[]> {
    const rows = await this.session.queryAll<{
      cycle_id: number | bigint;
      member_rel_path: string;
      member: string;
      position: number | bigint;
    }>(
      "SELECT cycle_id, member_rel_path, member, position FROM cg_symbols_cycles WHERE scope = ? ORDER BY cycle_id, position",
      [scope],
    );
    const grouped = new Map<number, CycleEntry>();
    for (const row of rows) {
      const cycleId = Number(row.cycle_id);
      let entry = grouped.get(cycleId);
      if (!entry) {
        entry =
          scope === "method" ? { cycleId, scope, members: [], memberLocations: [] } : { cycleId, scope, members: [] };
        grouped.set(cycleId, entry);
      }
      entry.members.push(row.member);
      entry.memberLocations?.push({ symbolId: row.member, relativePath: row.member_rel_path });
    }
    const entries = [...grouped.values()];
    if (!pathPattern) return entries;
    // The same matcher the explore tools enforce pathPattern with.
    const isMatch = compilePathPatternMatcher(pathPattern);
    if (!isMatch) return entries;
    return entries.filter((e) => memberPaths(e).some((p) => isMatch(p)));
  }

  /**
   * The whole file dependency graph in two statements: every walked file with
   * its symbol count, and every `cg_symbols_edges_file` row weighted by the
   * resolved calls crossing it (bd tea-rags-mcp-thc7s).
   *
   * The edge set is the FILE table, never pairs derived from method edges: it
   * is the relation `codegraph.file.instability` is counted over, so judging an
   * edge by its endpoints' instability is only meaningful on it. The method
   * graph disagrees with it heavily — measured, 41% of tea-rags' and 57% of
   * taxdome's cross-file call pairs have no file edge (a call resolved through
   * a re-export barrel, a Ruby call on a typed receiver whose constant the file
   * never names) — so a call pair with no file edge contributes no weight
   * anywhere rather than inventing an edge neither endpoint's fan counted.
   *
   * No endpoint filter: an edge to a file the walk never extracted still counts
   * toward its source's fanOut, exactly as `getFileMetricsBulk` counts it, and
   * dropping it here would move that file's instability. Deciding which edges
   * to judge is the caller's.
   */
  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    const fileRows = await this.session.queryAll<{ rel_path: string; language: string; symbol_count: number | string }>(
      `SELECT f.rel_path, f.language, COUNT(s.symbol_id) AS symbol_count
       FROM cg_symbols_files f
       LEFT JOIN cg_symbols s ON s.rel_path = f.rel_path
       GROUP BY f.rel_path, f.language
       ORDER BY f.rel_path`,
    );
    // Weighted like chunk fanIn: SUM of per-edge dispatch confidence, legacy
    // NULL rows as 1.0. `target_symbol_id IS NOT NULL` mirrors every other
    // method-edge read — an unpinned call is not a resolved one.
    const edgeRows = await this.session.queryAll<{
      source_rel_path: string;
      target_rel_path: string;
      call_weight: number | string;
      imported_export_names: string | null;
      reexported_export_names: string | null;
    }>(
      `SELECT e.source_rel_path, e.target_rel_path, COALESCE(c.call_weight, 0) AS call_weight,
              e.imported_export_names, e.reexported_export_names
       FROM cg_symbols_edges_file e
       LEFT JOIN (
         SELECT source_rel_path, target_rel_path, SUM(COALESCE(confidence, 1.0)) AS call_weight
         FROM cg_symbols_edges_method
         WHERE target_symbol_id IS NOT NULL
         GROUP BY source_rel_path, target_rel_path
       ) c ON c.source_rel_path = e.source_rel_path AND c.target_rel_path = e.target_rel_path
       ORDER BY e.source_rel_path, e.target_rel_path`,
    );
    return {
      files: fileRows.map((r) => ({ relPath: r.rel_path, language: r.language, symbolCount: Number(r.symbol_count) })),
      edges: edgeRows.map((r) => {
        // bd tea-rags-mcp-r8hme.2 — present only when the walk recorded them.
        const imported = decodeFileEdgeExportNames(r.imported_export_names);
        const reexported = decodeFileEdgeExportNames(r.reexported_export_names);
        return {
          sourceRelPath: r.source_rel_path,
          targetRelPath: r.target_rel_path,
          callWeight: Number(r.call_weight),
          ...(imported ? { importedExportNames: imported } : {}),
          ...(reexported ? { reexportedExportNames: reexported } : {}),
        };
      }),
    };
  }

  /**
   * Resolved method edges into members declared `private` / `protected` or
   * named with a leading underscore, whose declaring file is one of
   * `languages` (bd tea-rags-mcp-r8hme.1). The name / visibility test only
   * narrows the candidate set; which edge is a convention-privacy leak is the
   * boundary diagnostics' call.
   */
  async readNonPublicMemberEdges(languages: readonly string[]): Promise<NonPublicMemberEdge[]> {
    if (languages.length === 0) return [];
    const rows = await this.session.queryAll<{
      source_rel_path: string;
      source_symbol_id: string;
      target_rel_path: string;
      target_symbol_id: string;
      short_name: string;
      visibility: string | null;
      language: string;
      call_expression: string;
    }>(
      `SELECT m.source_rel_path, m.source_symbol_id, m.target_rel_path, m.target_symbol_id,
              s.short_name, s.visibility, f.language, m.call_expression
       FROM cg_symbols_edges_method m
       JOIN cg_symbols s ON s.rel_path = m.target_rel_path AND s.symbol_id = m.target_symbol_id
       JOIN cg_symbols_files f ON f.rel_path = m.target_rel_path
       WHERE m.target_symbol_id IS NOT NULL
         AND f.language IN (${languages.map(() => "?").join(", ")})
         AND (s.visibility IN ('private', 'protected') OR starts_with(s.short_name, '_'))
       ORDER BY m.source_rel_path, m.source_symbol_id, m.target_rel_path, m.target_symbol_id`,
      [...languages],
    );
    return rows.map((r) => ({
      sourceRelPath: r.source_rel_path,
      sourceSymbolId: r.source_symbol_id,
      targetRelPath: r.target_rel_path,
      targetSymbolId: r.target_symbol_id,
      targetShortName: r.short_name,
      targetVisibility: r.visibility,
      targetLanguage: r.language,
      callExpression: r.call_expression,
    }));
  }

  /** The files importing `relPath` (bd tea-rags-mcp-gfvr8). */
  async getFileImporters(relPath: RelPath): Promise<FileImportLookup> {
    return this.readFileImportEdges(relPath, "target_rel_path");
  }

  /** The files `relPath` imports (bd tea-rags-mcp-gfvr8). */
  async getFileImports(relPath: RelPath): Promise<FileImportLookup> {
    return this.readFileImportEdges(relPath, "source_rel_path");
  }

  /**
   * One file's `cg_symbols_edges_file` rows on one side, weighted exactly like
   * `readFileDependencyGraph`'s edges — the same method-edge aggregate, only
   * restricted to the rows the file anchors, so a single-file lookup never
   * aggregates the whole method table. `anchor` is one of two column literals
   * chosen by the caller, never user input, so it is inlined; the path is bound.
   */
  private async readFileImportEdges(
    relPath: RelPath,
    anchor: "source_rel_path" | "target_rel_path",
  ): Promise<FileImportLookup> {
    const edgeRows = await this.session.queryAll<{
      source_rel_path: string;
      target_rel_path: string;
      import_text: string | null;
      call_weight: number | string;
    }>(
      `SELECT e.source_rel_path, e.target_rel_path, e.import_text, COALESCE(c.call_weight, 0) AS call_weight
       FROM cg_symbols_edges_file e
       LEFT JOIN (
         SELECT source_rel_path, target_rel_path, SUM(COALESCE(confidence, 1.0)) AS call_weight
         FROM cg_symbols_edges_method
         WHERE target_symbol_id IS NOT NULL AND ${anchor} = ?
         GROUP BY source_rel_path, target_rel_path
       ) c ON c.source_rel_path = e.source_rel_path AND c.target_rel_path = e.target_rel_path
       WHERE e.${anchor} = ?
       ORDER BY e.source_rel_path, e.target_rel_path`,
      [relPath, relPath],
    );
    const known = await this.session.queryAll<{ n: number | string }>(
      "SELECT COUNT(*) AS n FROM cg_symbols_files WHERE rel_path = ?",
      [relPath],
    );
    return {
      fileKnown: Number(known[0]?.n ?? 0) > 0,
      edges: edgeRows.map((r) => ({
        sourceRelPath: r.source_rel_path,
        targetRelPath: r.target_rel_path,
        importText: r.import_text,
        callWeight: Number(r.call_weight),
      })),
    };
  }

  /**
   * Stream the adjacency for the requested scope as `[source, target]`
   * pairs, fetched from DuckDB one result chunk (~2048 rows) at a time.
   *
   * Method-scope vertices are `fileScopedSymbolKey(relPath, symbolId)` of each
   * endpoint's own file, never the bare id — a bare id is one vertex for every
   * namesake, which merged unrelated cycles and shared one PageRank across
   * them (bd tea-rags-mcp-4g9ga).
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
        : "SELECT source_rel_path, source_symbol_id, target_rel_path, target_symbol_id, COALESCE(confidence, 1.0) FROM cg_symbols_edges_method WHERE target_symbol_id IS NOT NULL";
    for await (const row of this.session.streamRows(sql)) {
      if (scope === "file") {
        const [source, target] = row;
        // Defensive: keep a null from ever becoming the string "null".
        if (source === null || source === undefined || target === null || target === undefined) continue;
        yield [String(source), String(target)];
        continue;
      }
      const [sourcePath, source, targetPath, target, weight] = row;
      // Defensive: WHERE already excludes null targets, but keep the guard so a
      // null can never become the string "null".
      if (source === null || source === undefined || target === null || target === undefined) continue;
      yield [
        methodVertex(sourcePath, source),
        methodVertex(targetPath, target),
        weight === null || weight === undefined ? 1 : Number(weight),
      ];
    }
  }

  /**
   * Materialise the adjacency map for the requested scope from the
   * appropriate edge table. For file scope, vertices are relPath; for
   * method scope, vertices are file-scoped symbol keys — the vertex identity
   * `streamAdjacency` yields (bd tea-rags-mcp-4g9ga). Method edges with null
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
    const adj = new Map<string, string[]>();
    for await (const [source, target] of this.streamAdjacency(scope)) {
      const list = adj.get(source);
      if (list) list.push(target);
      else adj.set(source, [target]);
    }
    return adj;
  }

  /**
   * Replace `scope`'s cycles. A method-scope member arrives as the vertex id
   * `streamAdjacency` yielded and is split into `(member_rel_path, member)`; a
   * file-scope member is its own path. A method member with no separator — a
   * caller handing bare ids — lands under the unknown (`""`) file.
   */
  async replaceCycles(scope: CycleScope, sccs: readonly (readonly string[])[]): Promise<void> {
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_symbols_cycles WHERE scope = ?", [scope]);
      const rows: unknown[][] = [];
      for (let cycleId = 0; cycleId < sccs.length; cycleId++) {
        const members = sccs[cycleId];
        for (let position = 0; position < members.length; position++) {
          const vertex = members[position];
          if (scope === "file") {
            rows.push([cycleId, scope, vertex, vertex, position]);
          } else {
            const { relPath, symbolId } = parseFileScopedSymbolKey(vertex);
            rows.push([cycleId, scope, relPath, symbolId, position]);
          }
        }
      }
      await this.session.insertBatched(
        "cg_symbols_cycles",
        ["cycle_id", "scope", "member_rel_path", "member", "position"],
        rows,
      );
    });
  }

  /**
   * Replace every rank. Keys are method-scope vertex ids, split into
   * `(rel_path, symbol_id)`; a bare-id key lands under the unknown (`""`) file,
   * which readers fan out to every namesake — the pre-028 merged semantics.
   */
  async replacePageRanks(ranks: ReadonlyMap<string, number>): Promise<void> {
    return this.session.transaction(async () => {
      // Recreated, not `DELETE`d: the keyed table otherwise keeps every previous
      // recompute in the file (bd tea-rags-mcp-dvzdm — 4.84M stored rows for 58k
      // live on taxdome). `recreateEmptyTable` carries the reason.
      await this.session.recreateEmptyTable("cg_symbols_metrics");
      const rows = [...ranks].map(([vertex, rank]) => {
        const { relPath, symbolId } = parseFileScopedSymbolKey(vertex);
        return [relPath, symbolId, String(rank)];
      });
      await this.session.insertBatched("cg_symbols_metrics", ["rel_path", "symbol_id", "page_rank"], rows);
      // The last write of every full recompute: the derived tables describe the
      // current graph again (bd tea-rags-mcp-dy852).
      await this.session.exec("DELETE FROM cg_derived_stale");
    });
  }

  /**
   * Cheap derived-table prune for deleted files (bd tea-rags-mcp-dy852), in
   * place of the whole-graph recompute a deletion-only reindex does not run:
   * drop every cycle (either scope) with a member in a deleted file, drop the
   * deleted files' ranks, and mark the rest stale — every remaining rank was
   * computed over a graph that still held the deleted nodes. The next full
   * recompute clears the mark (`replacePageRanks`).
   *
   * Must run BEFORE the files' base rows are removed: only a path
   * `cg_symbols_files` still knows marks the tables stale, so deleting a file
   * the graph never walked (a README) costs the next run nothing.
   */
  async pruneDerivedForDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    const unique = [...new Set(relPaths)];
    if (unique.length === 0) return;
    const placeholders = unique.map(() => "?").join(", ");
    await this.session.transaction(async () => {
      const walked = await this.session.queryAll<{ n: number | bigint }>(
        `SELECT COUNT(*) AS n FROM cg_symbols_files WHERE rel_path IN (${placeholders})`,
        unique,
      );
      // Bounded by the repository's cycle membership (tens of rows on this
      // project's own index), so the touched cycles are named here and each one
      // deleted by its key.
      const touched = await this.session.queryAll<{ scope: string; cycle_id: number | bigint }>(
        `SELECT DISTINCT scope, cycle_id FROM cg_symbols_cycles WHERE member_rel_path IN (${placeholders})`,
        unique,
      );
      for (const { scope, cycle_id } of touched) {
        await this.session.run("DELETE FROM cg_symbols_cycles WHERE scope = ? AND cycle_id = ?", [
          scope,
          Number(cycle_id),
        ]);
      }
      await this.session.run(`DELETE FROM cg_symbols_metrics WHERE rel_path IN (${placeholders})`, unique);
      if (Number(walked[0]?.n ?? 0) > 0) {
        await this.session.exec("INSERT OR IGNORE INTO cg_derived_stale (marker) VALUES ('derived')");
      }
    });
  }

  /** Whether a deletion pruned the derived tables since the last full recompute. */
  async hasStaleDerivedTables(): Promise<boolean> {
    const rows = await this.session.queryAll<{ n: number | bigint }>("SELECT COUNT(*) AS n FROM cg_derived_stale");
    return Number(rows[0]?.n ?? 0) > 0;
  }

  /**
   * The PageRank of one declaration. With `relPath`: the rank stored for that
   * file, else a rank carried without a file (migration 028), else 0. Without
   * it the bare id is ambiguous across namesakes, so the highest rank any
   * declaration of that name holds is returned. 0 when nothing is ranked.
   */
  async getPageRank(symbolId: SymbolId, relPath?: RelPath): Promise<number> {
    const rows =
      relPath === undefined
        ? await this.session.queryAll<{ page_rank: number | bigint | string | null }>(
            "SELECT MAX(page_rank) AS page_rank FROM cg_symbols_metrics WHERE symbol_id = ?",
            [symbolId],
          )
        : await this.session.queryAll<{ page_rank: number | bigint | string | null }>(
            `SELECT page_rank FROM cg_symbols_metrics
              WHERE symbol_id = ? AND rel_path IN (?, ?)
              ORDER BY rel_path = ? DESC LIMIT 1`,
            [symbolId, relPath, UNKNOWN_REL_PATH, relPath],
          );
    const raw = rows[0]?.page_rank;
    return raw === undefined || raw === null ? 0 : Number(raw);
  }
}
