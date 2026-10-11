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
  type CodegraphGraphAnalyticsStore,
  type CycleEntry,
  type CycleScope,
  type FileDependencyGraph,
  type FileImportLookup,
  type FileTypeHeritage,
  type NonPublicMemberEdge,
  type RelPath,
  type SymbolId,
} from "../../contracts/types/codegraph.js";
import { compilePathPatternMatcher } from "../../primitives/paths/index.js";
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

/** The target member's owner type, last namespace segment (`Owner` of `A::Owner#run`); '' for a free function. */
const TARGET_OWNER_SQL = String.raw`regexp_extract(target_symbol_id, '([A-Za-z0-9_$]+)[#.][^#.]*$', 1)`;

/**
 * Whether a resolved method-edge row went through a FRAMEWORK's interface (bd
 * tea-rags-mcp-4vj2u): it runs along no inheritance edge (`inh`, joined by the
 * caller — a subclass's `super(…)` names no member, yet runs its base's own
 * logic), its call text never NAMES the member it landed on, and it is no
 * construction of that member's owner.
 *   - Names: some identifier token of the call text is a contiguous run of the
 *     target member's `_`-separated name segments, a Ruby `?` / `!` / `=`
 *     suffix aside — the whole name (`x.public_send(:refresh!)` names
 *     `refresh!`) or the part the caller selects (`Policy.authorized?(u,
 *     :view_entries)` routed to `Policy#can_view_entries?` names it: the caller
 *     picked which logic runs).
 *   - Construction: the owner type called directly (`new Owner(…)`,
 *     `new Owner<T>(…)`, `Owner(…)`, anywhere in the text, so one nested in
 *     another call's argument counts).
 * `Worker.perform_async(id)` routed to `Worker#perform` does neither: the
 * caller names the framework's enqueue verb, the framework derives the
 * entrypoint. Derived from the persisted call text and target id, so it needs
 * no re-walk.
 */
const FRAMEWORK_ROUTED_CALL_SQL = String.raw`inh.source_rel_path IS NULL AND NOT (
  len(list_filter(
    regexp_split_to_array(call_expression, '[^A-Za-z0-9_$]+'),
    token -> token <> '' AND contains(
      '_' || rtrim(regexp_extract(target_symbol_id, '([^#.]+)$', 1), '?!=') || '_',
      '_' || token || '_'
    )
  )) > 0
  OR (
    ${TARGET_OWNER_SQL} <> ''
    AND regexp_matches(
      call_expression,
      '(^|[^A-Za-z0-9_$])' || replace(${TARGET_OWNER_SQL}, '$', '\$') || '\s*(<[^()]*>)?\s*\('
    )
  )
)`;

/**
 * The CTEs (for a `WITH RECURSIVE` head) ending in `edge_call_weight(source_rel_path,
 * target_rel_path, call_weight, framework_routed_call_weight)`: the resolved
 * calls crossing each `cg_symbols_edges_file` row (bd tea-rags-mcp-r8hme.52.1).
 *
 * A call lands on the file that DEFINES its target, but an import of a barrel
 * targets the barrel, so the exact-pair join read every `S → index.ts` edge as
 * weight 0 while S called through it (562 of tea-rags' 6009 file edges,
 * 1746 of 5386 call weight unattributed). Each `(S, D)` call aggregate is
 * therefore credited to EXACTLY ONE file edge of S:
 *   - the direct edge `S → D` when it exists;
 *   - otherwise the edge `S → B` whose re-export closure reaches D through the
 *     fewest re-export hops, code-point order of B breaking a tie (one definer
 *     reached through two barrels counts once, never twice).
 * The closure follows rows carrying `reexported_export_names` transitively —
 * barrels nest — and stops at a file already on the chain, so a re-export
 * cycle terminates. A call pair no file edge reaches still contributes no
 * weight anywhere, and routing never adds an edge. An intra-file call is
 * never routed through a barrel re-exporting its own file.
 *
 * `callSourceFilter` narrows the aggregated method edges (alias `m`) to the
 * sources a single-file lookup needs; it may bind parameters, which come
 * BEFORE the statement's own.
 */
function edgeCallWeightCtes(callSourceFilter: string): string {
  return `reexport_chain(barrel_rel_path, definer_rel_path, hops, chain) AS (
      SELECT source_rel_path, target_rel_path, 1, [source_rel_path, target_rel_path]
      FROM cg_symbols_edges_file
      WHERE reexported_export_names IS NOT NULL AND source_rel_path <> target_rel_path
      UNION ALL
      SELECT r.barrel_rel_path, e.target_rel_path, r.hops + 1, list_append(r.chain, e.target_rel_path)
      FROM reexport_chain r
      JOIN cg_symbols_edges_file e ON e.source_rel_path = r.definer_rel_path AND e.reexported_export_names IS NOT NULL
      WHERE NOT list_contains(r.chain, e.target_rel_path)
    ),
    reexport_reach AS (
      SELECT barrel_rel_path, definer_rel_path, MIN(hops) AS hops FROM reexport_chain GROUP BY 1, 2
    ),
    call_pair AS (
      SELECT m.source_rel_path, m.target_rel_path, SUM(COALESCE(m.confidence, 1.0)) AS call_weight,
             SUM(CASE WHEN ${FRAMEWORK_ROUTED_CALL_SQL} THEN COALESCE(m.confidence, 1.0) ELSE 0 END)
               AS framework_routed_call_weight
      FROM cg_symbols_edges_method m
      LEFT JOIN (
        SELECT DISTINCT i.source_rel_path, s.rel_path AS target_rel_path
        FROM cg_symbols_inheritance i
        JOIN cg_symbols s ON s.symbol_id = i.ancestor_symbol_id
      ) inh ON inh.source_rel_path = m.source_rel_path AND inh.target_rel_path = m.target_rel_path
      WHERE m.target_symbol_id IS NOT NULL ${callSourceFilter}
      GROUP BY m.source_rel_path, m.target_rel_path
    ),
    call_pair_credit AS (
      SELECT c.source_rel_path, c.target_rel_path AS definer_rel_path, e.target_rel_path AS credited_rel_path, 0 AS hops,
             c.call_weight, c.framework_routed_call_weight
      FROM call_pair c
      JOIN cg_symbols_edges_file e ON e.source_rel_path = c.source_rel_path AND e.target_rel_path = c.target_rel_path
      UNION ALL
      SELECT c.source_rel_path, c.target_rel_path, e.target_rel_path, r.hops, c.call_weight, c.framework_routed_call_weight
      FROM call_pair c
      JOIN reexport_reach r ON r.definer_rel_path = c.target_rel_path
      JOIN cg_symbols_edges_file e ON e.source_rel_path = c.source_rel_path AND e.target_rel_path = r.barrel_rel_path
      WHERE c.source_rel_path <> c.target_rel_path
    ),
    edge_call_weight AS (
      SELECT source_rel_path, credited_rel_path AS target_rel_path, SUM(call_weight) AS call_weight,
             SUM(framework_routed_call_weight) AS framework_routed_call_weight
      FROM (
        SELECT * FROM call_pair_credit
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY source_rel_path, definer_rel_path ORDER BY hops, credited_rel_path COLLATE "binary"
        ) = 1
      )
      GROUP BY source_rel_path, credited_rel_path
    )`;
}

/** `rel_path` of a derived row carried over by migration 028 — its file is unknown. */
const UNKNOWN_REL_PATH = "";

/** Vertex id of a method-scope node: the declaration, not the bare name. */
function methodVertex(relPath: unknown, symbolId: unknown): string {
  return fileScopedSymbolKey({ relPath: String(relPath), symbolId: String(symbolId) });
}

export class DuckDbGraphAnalyticsStore implements Omit<
  CodegraphGraphAnalyticsStore,
  "diffSymbolSignals" | "refreshSymbolSignalsPrev" | "computeAndPersistCyclesAndSignals"
> {
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
   * A call resolved through a re-export barrel is the exception that HAS an
   * edge: its weight is credited to the importer's edge into the barrel, one
   * edge per call pair (`edgeCallWeightCtes`, bd tea-rags-mcp-r8hme.52.1).
   *
   * No endpoint filter: an edge to a file the walk never extracted still counts
   * toward its source's fanOut, exactly as `getFileMetricsBulk` counts it, and
   * dropping it here would move that file's instability. Deciding which edges
   * to judge is the caller's.
   *
   * A third statement attaches each file's `typeHeritage` (bd
   * tea-rags-mcp-r8hme.52.6): every DIRECT supertype a declared type names in
   * `cg_type_declarations.supertypes` (re-opening rows included), resolved by
   * exact `type_id` or `short_name` to the files declaring it; a supertype no
   * project file declares is dropped.
   */
  async readFileDependencyGraph(): Promise<FileDependencyGraph> {
    const fileRows = await this.session.queryAll<{
      rel_path: string;
      language: string;
      symbol_count: number | string;
      abstract_type_count: number | string | null;
      concrete_type_count: number | string | null;
      outer_scope_names: string[] | null;
    }>(
      // bd tea-rags-mcp-r8hme.11 — the outermost scope per symbol, distinct per
      // file; `list` skips the NULLs a scopeless symbol yields.
      `SELECT f.rel_path, f.language, f.abstract_type_count, f.concrete_type_count,
              COUNT(s.symbol_id) AS symbol_count,
              list(DISTINCT json_extract_string(s.scope_json, '$[0]') ORDER BY json_extract_string(s.scope_json, '$[0]'))
                FILTER (WHERE json_extract_string(s.scope_json, '$[0]') IS NOT NULL) AS outer_scope_names
       FROM cg_symbols_files f
       LEFT JOIN cg_symbols s ON s.rel_path = f.rel_path
       GROUP BY f.rel_path, f.language, f.abstract_type_count, f.concrete_type_count
       ORDER BY f.rel_path`,
    );
    // Weighted like chunk fanIn: SUM of per-edge dispatch confidence, legacy
    // NULL rows as 1.0. `target_symbol_id IS NOT NULL` mirrors every other
    // method-edge read — an unpinned call is not a resolved one.
    // `framework_routed_call_weight` (bd tea-rags-mcp-4vj2u): the part of it
    // whose call text never names the member it lands on — see
    // FRAMEWORK_ROUTED_CALL_SQL.
    const edgeRows = await this.session.queryAll<{
      source_rel_path: string;
      target_rel_path: string;
      call_weight: number | string;
      framework_routed_call_weight: number | string | null;
      import_text: string | null;
      imported_export_names: string | null;
      reexported_export_names: string | null;
    }>(
      `WITH RECURSIVE ${edgeCallWeightCtes("")}
       SELECT e.source_rel_path, e.target_rel_path, COALESCE(c.call_weight, 0) AS call_weight,
              c.framework_routed_call_weight,
              e.import_text, e.imported_export_names, e.reexported_export_names
       FROM cg_symbols_edges_file e
       LEFT JOIN edge_call_weight c ON c.source_rel_path = e.source_rel_path AND c.target_rel_path = e.target_rel_path
       ORDER BY e.source_rel_path, e.target_rel_path`,
    );
    const heritageByFile = await this.readFileTypeHeritage();
    return {
      files: fileRows.map((r) => ({
        relPath: r.rel_path,
        language: r.language,
        symbolCount: Number(r.symbol_count),
        // bd tea-rags-mcp-r8hme.8 — present only when the walk took the census.
        ...(r.abstract_type_count !== null && r.concrete_type_count !== null
          ? {
              typeAbstractness: {
                abstractTypeCount: Number(r.abstract_type_count),
                concreteTypeCount: Number(r.concrete_type_count),
              },
            }
          : {}),
        ...(r.outer_scope_names && r.outer_scope_names.length > 0 ? { outerScopeNames: [...r.outer_scope_names] } : {}),
        ...(heritageByFile.has(r.rel_path) ? { typeHeritage: heritageByFile.get(r.rel_path) } : {}),
      })),
      edges: edgeRows.map((r) => {
        // bd tea-rags-mcp-r8hme.2 — present only when the walk recorded them.
        const imported = decodeFileEdgeExportNames(r.imported_export_names);
        const reexported = decodeFileEdgeExportNames(r.reexported_export_names);
        const frameworkRouted = Number(r.framework_routed_call_weight ?? 0);
        return {
          sourceRelPath: r.source_rel_path,
          targetRelPath: r.target_rel_path,
          callWeight: Number(r.call_weight),
          // bd tea-rags-mcp-4vj2u — present only when a call went through a framework's interface.
          ...(frameworkRouted > 0 ? { frameworkRoutedCallWeight: frameworkRouted } : {}),
          // bd tea-rags-mcp-xb669.6 — the norms tell a nested-constant reference from a role edge.
          ...(r.import_text ? { importText: r.import_text } : {}),
          ...(imported ? { importedExportNames: imported } : {}),
          ...(reexported ? { reexportedExportNames: reexported } : {}),
        };
      }),
    };
  }

  /**
   * `typeHeritage` per declaring file, grouped from one flat row per (file,
   * type, supertype, declaring file), already sorted and deduplicated by the
   * statement. Two equi-joins under UNION rather than one OR join, which
   * DuckDB plans as a nested loop.
   */
  private async readFileTypeHeritage(): Promise<Map<RelPath, FileTypeHeritage[]>> {
    const rows = await this.session.queryAll<{
      rel_path: string;
      type_name: string;
      supertype_name: string;
      declaring_rel_path: string;
    }>(
      `WITH sup AS (SELECT rel_path, short_name, unnest(supertypes) AS name FROM cg_type_declarations)
       SELECT s.rel_path, s.short_name AS type_name, s.name AS supertype_name, d.rel_path AS declaring_rel_path
         FROM sup s JOIN cg_type_declarations d ON d.type_id = s.name
       UNION
       SELECT s.rel_path, s.short_name AS type_name, s.name AS supertype_name, d.rel_path AS declaring_rel_path
         FROM sup s JOIN cg_type_declarations d ON d.short_name = s.name
       ORDER BY 1, 2, 3, 4`,
    );
    const byFile = new Map<RelPath, FileTypeHeritage[]>();
    for (const row of rows) {
      let types = byFile.get(row.rel_path);
      if (!types) {
        types = [];
        byFile.set(row.rel_path, types);
      }
      let type = types.at(-1);
      if (type?.typeName !== row.type_name) {
        type = { typeName: row.type_name, supertypes: [] };
        types.push(type);
      }
      let supertype = type.supertypes.at(-1);
      if (supertype?.name !== row.supertype_name) {
        supertype = { name: row.supertype_name, declaringRelPaths: [] };
        type.supertypes.push(supertype);
      }
      supertype.declaringRelPaths.push(row.declaring_rel_path);
    }
    return byFile;
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
      `WITH RECURSIVE ${edgeCallWeightCtes(
        // Crediting a call needs every file edge of its SOURCE, so an importer
        // lookup aggregates the calls of each file importing `relPath`.
        anchor === "source_rel_path"
          ? "AND m.source_rel_path = ?"
          : "AND m.source_rel_path IN (SELECT source_rel_path FROM cg_symbols_edges_file WHERE target_rel_path = ?)",
      )}
       SELECT e.source_rel_path, e.target_rel_path, e.import_text, COALESCE(c.call_weight, 0) AS call_weight
       FROM cg_symbols_edges_file e
       LEFT JOIN edge_call_weight c ON c.source_rel_path = e.source_rel_path AND c.target_rel_path = e.target_rel_path
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
