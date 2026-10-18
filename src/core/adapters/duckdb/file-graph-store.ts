/**
 * Custody of the file-node tables: `cg_symbols_files` plus everything keyed by
 * `source_rel_path` (file edges, type-only file edges, method edges,
 * inheritance, ambiguous fan-out)
 * and the per-file pass-1 aggregate slice `cg_pass1_aggregates`, which is keyed
 * by `rel_path` because the row IS the file rather than a slice of its edges.
 *
 * One rule governs the whole module — a file's rows are replaced, never merged.
 * Re-walking a file DELETEs its `source_rel_path` slice and re-INSERTs it, so a
 * resolved-away edge or fan-out cannot survive a reindex. `writeFileRows` is
 * that lifecycle without a transaction around it; the caller decides the
 * granularity (one file per transaction, or M files in one).
 *
 * `removeFile` is the deletion counterpart, and `listFileContentHashes` /
 * `hasData` are the two reads over the file-node table itself (the repair
 * check's hash diff and the drift detector's liveness probe). Edge-derived
 * metrics live in `DuckDbFileMetricsReader`, not here.
 */

import type {
  BulkFileUpsertEntry,
  CallerArgObservation,
  CodegraphPass1FileAggregates,
  GraphEdges,
  GraphFileNode,
  Pass1AggregateReadScope,
  PersistedCallerArgObservation,
  PersistedHierarchyDescendantDependency,
  RelPath,
} from "../../contracts/types/codegraph.js";
import {
  CG_PASS1_DEF_COLUMNS,
  CG_PASS1_KEY_COLUMNS,
  CG_PASS1_VALUE_COLUMNS,
  fromCgPass1Row,
  toCgPass1Row,
  type CgPass1AggregatesRow,
} from "./cg-pass1-aggregates-row.js";
import { encodeFileEdgeExportNames, encodeReexportBindings } from "./file-edge-export-names-codec.js";
import type { DuckDbGraphSession } from "./graph-session.js";
import {
  encodeResidualClassTargets,
  residualClassSetKey,
  ROW_CLASS_TARGETS_LIMIT,
} from "./residual-class-targets-codec.js";

/**
 * Files per write group in {@link DuckDbFileGraphStore#writeFileRowsBulk}.
 *
 * Two live crashes shaped this number, and the second is why the group no
 * longer issues a blind DELETE at all.
 *
 * bd tea-rags-mcp-wgt19 follow-up (taxdome CODEGRAPH_FORCE_RESOLVE,
 * 2026-08-13): batching the DELETE across the WHOLE incoming set — every
 * table's DELETE first, then every table's INSERT — crashed the daemon with a
 * native DuckDB FatalException, "Failed to append to
 * PRIMARY_cg_symbols_edges_file_2: ... duplicate key", from inside index
 * maintenance during commit. Grouping bounded the pending-delete window and
 * the crash rate fell, but it did not go away: the same abort took the daemon
 * down nine more times on 2026-08-17 (bd tea-rags-mcp-8l8d3).
 *
 * It could not go away, because bounding the window was treating the symptom.
 * The shape DuckDB cannot survive is a transaction that DELETEs a key and
 * re-INSERTs it — and a per-file "replace the slice" write produced that
 * overlap for every unchanged edge, which is most of them. The group now
 * writes through {@link DuckDbGraphSession#applyScopedRowDiff}, which removes
 * the overlap outright; see that method for the engine mechanism.
 *
 * The size therefore stopped being a crash-avoidance knob and is now purely a
 * batching one: how many files' scope reads and edge rows one round of
 * statements covers.
 */
const BULK_WRITE_GROUP_FILES = 32;

/** Columns of each per-source-file table, split into PRIMARY KEY and the rest. */
const FILE_EDGE_KEYS = ["source_rel_path", "target_rel_path"] as const;
// Migration 030 (bd tea-rags-mcp-r8hme.2): the export names are VALUES, so a
// re-walk that changes only them rewrites the row instead of keeping the first.
// Migration 051 (bd tea-rags-mcp-zl3so): the alias table rides the same row.
// Migration 056: the walk writes NULL origin, so an import it finds replaces a
// model-derived edge, and a re-walk drops the file's model-derived edges.
const FILE_EDGE_VALUES = [
  "import_text",
  "imported_export_names",
  "reexported_export_names",
  "reexported_export_bindings",
  "origin",
] as const;
// Migration 037 (bd tea-rags-mcp-r8hme.12): same key as the runtime file edge.
const TYPE_ONLY_FILE_EDGE_VALUES = ["import_text"] as const;
export const METHOD_EDGE_KEYS = [
  "source_symbol_id",
  "source_rel_path",
  "call_expression",
  "target_rel_path",
  "target_symbol_key",
] as const;
// Migration 054: a static row writes NULL provenance, so a re-walk that proves a
// model edge statically turns it back into a static edge.
export const METHOD_EDGE_VALUES = [
  "target_symbol_id",
  "edge_kind",
  "confidence",
  "origin",
  "model",
  "p",
  "site_key",
] as const;
const INHERITANCE_KEYS = ["source_fq_name", "source_rel_path", "ancestor_fq_name", "kind"] as const;
const INHERITANCE_VALUES = ["source_symbol_id", "ancestor_symbol_id", "ordinal"] as const;
// Migration 027 (bd tea-rags-mcp-n9bmd): `source_rel_path` joined the key, so a
// namesake caller's aggregate in another file is a distinct row, not a collision.
const FANOUT_KEYS = ["source_symbol_id", "source_rel_path", "call_expression"] as const;
const FANOUT_VALUES = ["member", "candidate_count"] as const;
const STATIC_SAMPLE_KEYS = ["source_rel_path", "site_key"] as const;
const STATIC_SAMPLE_VALUES = [
  "language",
  "method_symbol_id",
  "method_start_line",
  "method_end_line",
  "line",
  "call_column",
  "receiver_text",
  "receiver_kind",
  "member",
  "outcome",
  "target_symbol_id",
  "reason",
  "owners",
  "candidates",
  "menu_overflow",
  "priority",
] as const;
const RESIDUAL_KEYS = ["source_rel_path", "site_key"] as const;
const RESIDUAL_VALUES = [
  "method_symbol_id",
  "method_start_line",
  "method_end_line",
  "line",
  "call_column",
  "receiver_text",
  "member",
  "kind",
  "candidates",
  "menu_hash",
  "menu_overflow",
  // Migration 055 (bd tea-rags-mcp-2m83f.38): the run-stats bucket of the site.
  "language",
  "receiver_kind",
  // Migration 059 (bd tea-rags-mcp-2m83f.48): why the menu is narrowed.
  "reason",
  // Migration 061 (bd tea-rags-mcp-2m83f.46): the receiver group the pass asks once.
  "receiver_group",
  "class_targets",
  // Migration 062 (bd tea-rags-mcp-2m83f.51): the chain hop an accepted class types.
  "downstream_group",
  // Migration 063 (bd tea-rags-mcp-2m83f.52): the shared class set a large group's row names.
  "class_set",
] as const;
// Migration 039 (bd tea-rags-mcp-7t2ee): one row per (file, type it asked about).
const HIERARCHY_DEPENDENCY_KEYS = ["source_rel_path", "type_name"] as const;
const HIERARCHY_DEPENDENCY_VALUES = ["descendant_names"] as const;
const CALLER_PARAM_OBSERVATION_KEYS = ["source_rel_path"] as const;
const CALLER_PARAM_OBSERVATION_VALUES = ["observations"] as const;
/**
 * What removing a file clears — the ONE table list both {@link
 * DuckDbFileGraphStore#removeFile} and its set-based form
 * {@link DuckDbFileGraphStore#removeFiles} walk, so a table one learns to clear
 * the other clears too. DuckDB rejects ON DELETE CASCADE, so the cascade is
 * these lists, in this order: edges first, `cg_symbols_files` last.
 *
 * - Edge tables are cleared where the file is the source OR the target.
 * - Per-source tables hold what the file's own walk wrote — the field-access
 *   edges among them (bd tea-rags-mcp-zy6hx): they carry no target path, the
 *   owner is a type NAME, so only the accessing file's removal clears them.
 *   So are the residual call sites (bd tea-rags-mcp-2m83f): the residual pass
 *   must not ask about calls in a file that is gone. So are the caller
 *   observations (bd tea-rags-mcp-2m83f.49): a gone caller types no parameter.
 * - Per-file tables, keyed by `rel_path`: the symbols; pass-1 aggregates; the
 *   resolve tallies (bd tea-rags-mcp-xpmwg — `getRunStats` sums them per
 *   language, so a deleted file's calls must stop counting); the declared
 *   identifiers (bd tea-rags-mcp-4p3sb.8 — or the naming lexicon keeps counting
 *   names from a file that is gone); the type declarations (bd
 *   tea-rags-mcp-vi0wx — or type roles keep counting its types); and the file
 *   row itself.
 */
export const REMOVED_FILE_EDGE_TABLES = [
  "cg_symbols_edges_method",
  "cg_symbols_edges_file",
  "cg_symbols_edges_file_type_only",
] as const;
export const REMOVED_FILE_SOURCE_TABLES = [
  "cg_symbols_inheritance",
  "cg_ambiguous_fanout",
  "cg_hierarchy_dependencies",
  "cg_symbols_edges_field",
  "cg_residual_call_sites",
  "cg_residual_external_sites",
  "cg_caller_param_observations",
  "cg_static_site_sample",
] as const;
export const REMOVED_FILE_REL_PATH_TABLES = [
  "cg_symbols",
  "cg_pass1_aggregates",
  "cg_file_resolve_stats",
  "cg_identifiers",
  "cg_type_declarations",
  "cg_symbols_files",
] as const;
/**
 * `removeFiles`' scratch list of the paths being removed, in the
 * connection-scoped `temp` catalog — never the database file. One name is safe:
 * every write runs serialized on the session's one connection.
 */
const REMOVED_PATHS_TEMP_TABLE = "temp.main.cg_removed_rel_paths";

/** `descendant_names` separator: a type name never holds a newline. */
const DESCENDANT_NAME_SEPARATOR = "\n";

function encodeDescendantNames(names: readonly string[]): string {
  return names.join(DESCENDANT_NAME_SEPARATOR);
}

function decodeDescendantNames(encoded: string): string[] {
  return encoded === "" ? [] : encoded.split(DESCENDANT_NAME_SEPARATOR);
}

export class DuckDbFileGraphStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /**
   * The per-file node + edge + inheritance + ambiguous-fanout write body,
   * WITHOUT the surrounding transaction. Shared by `upsertFile` (one
   * BEGIN/COMMIT per file) and `upsertFilesBulk` (one BEGIN/COMMIT per M
   * files) so both persist identical rows — the single-file form is literally
   * the group form with a group of one, which is what makes that equality a
   * property of the code rather than of two implementations kept in step.
   */
  async writeFileRows(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.writeFileRowsGroup([{ node, edges }]);
  }

  /**
   * Batched form of {@link writeFileRows}: one scope diff per GROUP of
   * {@link BULK_WRITE_GROUP_FILES} files instead of one write cycle per file.
   * Equivalent to calling `writeFileRows(node, edges)` once per entry in order
   * — a later entry for the same relPath fully REPLACES an earlier one
   * (last-wins per relPath), and cross-file PK collisions still resolve
   * first-wins, same as `INSERT OR IGNORE` racing an already-persisted row from
   * an earlier file. Empty `entries` is a no-op.
   */
  async writeFileRowsBulk(entries: readonly BulkFileUpsertEntry[]): Promise<void> {
    if (entries.length === 0) return;
    // Same last-wins collapse as DuckDbSymbolStore#upsertSymbolsBulk: a batch
    // may legitimately carry two entries for the same relPath (a re-walk).
    // Collapse BEFORE touching the DB so each relPath is reconciled once
    // against its FINAL entry's edges — never a union of both.
    const lastByRelPath = new Map<RelPath, BulkFileUpsertEntry>();
    for (const entry of entries) lastByRelPath.set(entry.node.relPath, entry);
    const deduped = [...lastByRelPath.values()];

    for (let i = 0; i < deduped.length; i += BULK_WRITE_GROUP_FILES) {
      await this.writeFileRowsGroup(deduped.slice(i, i + BULK_WRITE_GROUP_FILES));
    }
  }

  /**
   * Reconcile one group's five tables against the rows the group carries.
   *
   * Every table goes through `applyScopedRowDiff` scoped by `source_rel_path`
   * (`rel_path` for the node table), which is what keeps a re-walk from
   * deleting and re-inserting the keys it is about to write — the shape that
   * turns any failed commit into a daemon-killing native abort. See that method
   * for the engine mechanism and {@link BULK_WRITE_GROUP_FILES} for the two
   * live crashes that led here.
   */
  private async writeFileRowsGroup(group: readonly BulkFileUpsertEntry[]): Promise<void> {
    const relPaths = group.map((e) => e.node.relPath);

    const fileEdgeRows: unknown[][] = [];
    const methodEdgeRows: unknown[][] = [];
    const inheritanceRows: unknown[][] = [];
    const fanoutRows: unknown[][] = [];
    const residualRows: unknown[][] = [];
    const staticSampleRows: unknown[][] = [];
    /** Encoded class sets over the row limit, by key: stored once in `cg_residual_class_sets`. */
    const classSets = new Map<string, string>();
    const pass1Rows: unknown[][] = [];
    const typeOnlyFileEdgeRows: unknown[][] = [];
    const hierarchyDependencyRows: unknown[][] = [];
    const callerObservationRows: unknown[][] = [];
    for (const { node, edges } of group) {
      // A file may re-import the same module on different lines, so the same
      // (source, target) can arrive twice in one extraction — the diff keeps
      // the first, matching the INSERT OR IGNORE this replaced.
      for (const e of edges.fileEdges) {
        fileEdgeRows.push([
          node.relPath,
          e.targetRelPath,
          e.importText,
          encodeFileEdgeExportNames(e.importedExportNames),
          encodeFileEdgeExportNames(e.reexportedExportNames),
          encodeReexportBindings(e.reexportedExportBindings),
          null,
        ]);
      }
      for (const e of edges.typeOnlyFileEdges ?? []) {
        typeOnlyFileEdgeRows.push([node.relPath, e.targetRelPath, e.importText]);
      }
      // GraphEdges.methodEdges allows targetSymbolId=null (the resolver case
      // where an import resolves to a file but the called member isn't in that
      // file's exported symbol table). bd tea-rags-mcp-rtp6v / migration 026
      // re-keyed cg_symbols_edges_method on
      // (source_symbol_id, source_rel_path, call_expression, target_rel_path,
      // target_symbol_key), so those file-only edges PERSIST: target_symbol_id
      // is a plain nullable column, and the resolved target_rel_path is stored
      // with the row. The readers decide what it means — getCallees surfaces
      // it; graph analytics adjacency and the trace_path frontier keep
      // filtering it out.
      //
      // target_symbol_key is the PK-safe sentinel of target_symbol_id
      // (COALESCE(id, '')): DuckDB forbids NULL PK columns, and WITHOUT the
      // sentinel a 4-column key would collapse every same-file dispatch /
      // interface fan-out (bd tea-rags-mcp-n0zj / t5cji) to its first
      // candidate — the silent-drop class this re-key exists to remove.
      //
      // The same call shape may repeat — `this.cache.get(x)` invoked from two
      // branches of one method body. collectCalls emits one CallRef per
      // occurrence; the PK is edge-EXISTENCE semantics, not occurrence count,
      // so the first occurrence's provenance (edge_kind / confidence, bd 2jet,
      // defaulting to exact/1.0 when the resolver did not mark the edge as CHA
      // fan-out) is the one persisted.
      for (const e of edges.methodEdges) {
        methodEdgeRows.push([
          e.sourceSymbolId,
          node.relPath,
          e.callExpression,
          e.targetRelPath,
          e.targetSymbolId ?? "",
          e.targetSymbolId,
          e.edgeKind ?? "exact",
          e.confidence ?? 1.0,
          null,
          null,
          null,
          null,
        ]);
      }
      // Inheritance edges (bd tea-rags-mcp-f10y) — same per-source-file
      // lifecycle: a (source, ancestor, kind) declared twice in one extraction
      // (duplicate include) collapses to one row.
      for (const e of edges.inheritance ?? []) {
        inheritanceRows.push([
          e.sourceFqName,
          node.relPath,
          e.ancestorFqName,
          e.kind,
          e.sourceSymbolId,
          e.ancestorSymbolId,
          e.ordinal,
        ]);
      }
      // Ambiguous fan-out aggregates (bd tea-rags-mcp-f2jsb / j0pki) — a
      // fan-out resolved away must not survive the re-walk, and a repeated
      // (source, file, call_expression) is aggregate-existence, not occurrence
      // count. The file is part of the key (migration 027): a SymbolId is
      // unique per file, so a namesake caller elsewhere is its own aggregate.
      for (const a of edges.ambiguousFanouts ?? []) {
        fanoutRows.push([a.sourceSymbolId, node.relPath, a.callExpression, a.member, a.candidateCount]);
      }
      // Residual call sites: the slice is keyed by the NODE's path, so a row can
      // only land under the file being written; an absent field clears it.
      for (const r of edges.residualCallSites ?? []) {
        const encoded = r.classTargets === undefined ? null : encodeResidualClassTargets(r.member, r.classTargets);
        const shared =
          encoded !== null && (r.classTargets?.length ?? 0) > ROW_CLASS_TARGETS_LIMIT
            ? residualClassSetKey(r.member, encoded)
            : null;
        if (shared !== null && encoded !== null) classSets.set(shared, encoded);
        residualRows.push([
          node.relPath,
          r.siteKey,
          r.methodSymbolId,
          r.methodStartLine,
          r.methodEndLine,
          r.line,
          r.column,
          r.receiverText,
          r.member,
          r.kind,
          JSON.stringify(r.candidates),
          r.menuHash,
          r.menuOverflow,
          r.language ?? null,
          r.receiverKind ?? null,
          r.reason ?? null,
          r.receiverGroup ?? null,
          shared === null ? encoded : null,
          r.downstreamGroup ?? null,
          shared,
        ]);
      }
      for (const r of edges.staticSiteSample ?? []) {
        staticSampleRows.push([
          node.relPath,
          r.siteKey,
          r.language,
          r.methodSymbolId,
          r.methodStartLine,
          r.methodEndLine,
          r.line,
          r.column,
          r.receiverText,
          r.receiverKind,
          r.member,
          r.outcome,
          r.targetSymbolId,
          r.reason,
          r.owners,
          JSON.stringify(r.candidates),
          r.menuOverflow,
          r.priority,
        ]);
      }
      // The pass-1 slice, keyed by the NODE's path rather than the slice's own,
      // so the row can only ever land under the file being written.
      if (edges.pass1Aggregates !== undefined) {
        pass1Rows.push(toCgPass1Row({ ...edges.pass1Aggregates, relPath: node.relPath }));
      }
      for (const d of edges.hierarchyDependencies ?? []) {
        hierarchyDependencyRows.push([node.relPath, d.typeName, encodeDescendantNames(d.descendantNames)]);
      }
      if (edges.callerParamObservations !== undefined && edges.callerParamObservations.length > 0) {
        callerObservationRows.push([node.relPath, JSON.stringify(edges.callerParamObservations)]);
      }
    }

    await this.session.applyScopedRowDiff(
      "cg_symbols_files",
      "rel_path",
      relPaths,
      ["rel_path"],
      ["language", "content_hash", "abstract_type_count", "concrete_type_count"],
      // The census is NULL, never 0 / 0, when the walk did not take it (bd
      // tea-rags-mcp-r8hme.8): "not measured" and "no types" are two facts.
      group.map((e) => [
        e.node.relPath,
        e.node.language,
        e.node.contentHash ?? null,
        e.node.typeAbstractness?.abstractTypeCount ?? null,
        e.node.typeAbstractness?.concreteTypeCount ?? null,
      ]),
    );
    await this.session.applyScopedRowDiff(
      "cg_symbols_edges_file",
      "source_rel_path",
      relPaths,
      FILE_EDGE_KEYS,
      FILE_EDGE_VALUES,
      fileEdgeRows,
    );
    await this.session.applyScopedRowDiff(
      "cg_symbols_edges_file_type_only",
      "source_rel_path",
      relPaths,
      FILE_EDGE_KEYS,
      TYPE_ONLY_FILE_EDGE_VALUES,
      typeOnlyFileEdgeRows,
    );
    await this.session.applyScopedRowDiff(
      "cg_symbols_edges_method",
      "source_rel_path",
      relPaths,
      METHOD_EDGE_KEYS,
      METHOD_EDGE_VALUES,
      methodEdgeRows,
    );
    await this.session.applyScopedRowDiff(
      "cg_symbols_inheritance",
      "source_rel_path",
      relPaths,
      INHERITANCE_KEYS,
      INHERITANCE_VALUES,
      inheritanceRows,
    );
    await this.session.applyScopedRowDiff(
      "cg_ambiguous_fanout",
      "source_rel_path",
      relPaths,
      FANOUT_KEYS,
      FANOUT_VALUES,
      fanoutRows,
    );
    await this.session.applyScopedRowDiff(
      "cg_residual_call_sites",
      "source_rel_path",
      relPaths,
      RESIDUAL_KEYS,
      RESIDUAL_VALUES,
      residualRows,
    );
    if (classSets.size > 0) await this.storeResidualClassSets(classSets);
    await this.session.applyScopedRowDiff(
      "cg_static_site_sample",
      "source_rel_path",
      relPaths,
      STATIC_SAMPLE_KEYS,
      STATIC_SAMPLE_VALUES,
      staticSampleRows,
    );
    // Pass-1 aggregate slice (bd tea-rags-mcp-znxg8). Scoped by `rel_path` like
    // the node table rather than `source_rel_path`, because the row IS the file.
    // Riding the same reconciliation as the edges is the point: the slice is
    // replaced when the file is re-walked and removed when the file stops
    // declaring anything, with no second lifecycle to keep in step.
    await this.session.applyScopedRowDiff(
      "cg_pass1_aggregates",
      "rel_path",
      relPaths,
      CG_PASS1_KEY_COLUMNS,
      CG_PASS1_VALUE_COLUMNS,
      pass1Rows,
    );
    // Hierarchy dependencies (bd tea-rags-mcp-7t2ee) — the answers this file's
    // resolution read; a re-walk replaces them, so a type it stopped asking
    // about stops invalidating it.
    await this.session.applyScopedRowDiff(
      "cg_hierarchy_dependencies",
      "source_rel_path",
      relPaths,
      HIERARCHY_DEPENDENCY_KEYS,
      HIERARCHY_DEPENDENCY_VALUES,
      hierarchyDependencyRows,
    );
    // Caller observations (bd tea-rags-mcp-2m83f.49) — what this file passes to
    // its exact-edge callees; a re-walk replaces them.
    await this.session.applyScopedRowDiff(
      "cg_caller_param_observations",
      "source_rel_path",
      relPaths,
      CALLER_PARAM_OBSERVATION_KEYS,
      CALLER_PARAM_OBSERVATION_VALUES,
      callerObservationRows,
    );
  }

  /**
   * The persisted caller observations whose SOURCE file is of one of `scope`'s
   * languages (bd tea-rags-mcp-2m83f.49), in (file, site) order. Once per run,
   * before pass-2; scoped like {@link listHierarchyDependencies}.
   */
  async listCallerParamObservations(scope: Pass1AggregateReadScope): Promise<PersistedCallerArgObservation[]> {
    const select = `SELECT o.source_rel_path, f.language, o.observations
      FROM cg_caller_param_observations o JOIN cg_symbols_files f ON f.rel_path = o.source_rel_path`;
    const order = " ORDER BY o.source_rel_path";
    type Row = { source_rel_path: string; language: string; observations: string };
    let rows: Row[];
    if (scope.kind === "allLanguages") {
      rows = await this.session.queryAll<Row>(select + order);
    } else {
      if (scope.languages.length === 0) return [];
      const placeholders = scope.languages.map(() => "?").join(", ");
      rows = await this.session.queryAll<Row>(`${select} WHERE f.language IN (${placeholders})${order}`, [
        ...scope.languages,
      ]);
    }
    return rows.flatMap((r) =>
      (JSON.parse(r.observations) as CallerArgObservation[]).map((observation) => ({
        sourceRelPath: r.source_rel_path,
        language: r.language,
        observation,
      })),
    );
  }

  /**
   * Clear the content hash of every surviving file that declares a callee one
   * of `relPaths` observed (bd tea-rags-mcp-2m83f.49), so the drift repair
   * re-resolves it without that caller's evidence. Over-approximates — every
   * observed callee, not only those whose agreed type moves. Must run before
   * those files' observation rows are removed.
   */
  async invalidateCallerParamDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    if (relPaths.length === 0) return;
    const placeholders = relPaths.map(() => "?").join(", ");
    const rows = await this.session.queryAll<{ observations: string }>(
      `SELECT observations FROM cg_caller_param_observations WHERE source_rel_path IN (${placeholders})`,
      [...relPaths],
    );
    const targets = [
      ...new Set(rows.flatMap((r) => (JSON.parse(r.observations) as CallerArgObservation[]).map((o) => o.target))),
    ];
    if (targets.length === 0) return;
    await this.session.run(
      `UPDATE cg_symbols_files SET content_hash = NULL
        WHERE rel_path NOT IN (${placeholders})
          AND rel_path IN (SELECT rel_path FROM cg_symbols WHERE symbol_id IN (${targets.map(() => "?").join(", ")}))`,
      [...relPaths, ...targets],
    );
  }

  /**
   * The persisted hierarchy dependencies whose SOURCE file is of one of
   * `scope`'s languages (bd tea-rags-mcp-7t2ee). Once per run, at the barrier;
   * the language comes from the file row, so the filter runs in SQL.
   */
  async listHierarchyDependencies(scope: Pass1AggregateReadScope): Promise<PersistedHierarchyDescendantDependency[]> {
    const select = `SELECT d.source_rel_path, f.language, d.type_name, d.descendant_names
      FROM cg_hierarchy_dependencies d JOIN cg_symbols_files f ON f.rel_path = d.source_rel_path`;
    type Row = { source_rel_path: string; language: string; type_name: string; descendant_names: string };
    let rows: Row[];
    if (scope.kind === "allLanguages") {
      rows = await this.session.queryAll<Row>(select);
    } else {
      if (scope.languages.length === 0) return [];
      const placeholders = scope.languages.map(() => "?").join(", ");
      rows = await this.session.queryAll<Row>(`${select} WHERE f.language IN (${placeholders})`, [...scope.languages]);
    }
    return rows.map((r) => ({
      sourceRelPath: r.source_rel_path,
      language: r.language,
      typeName: r.type_name,
      descendantNames: decodeDescendantNames(r.descendant_names),
    }));
  }

  /**
   * Clear the content hash of every surviving file whose recorded dependency
   * lists a type `relPaths` declare (bd tea-rags-mcp-7t2ee), so the drift
   * repair re-walks it. The declared names come from `cg_symbols` — member ids
   * never appear in a descendant list, so no kind filter is needed. Must run
   * before those files' `cg_symbols` rows are removed.
   */
  async invalidateHierarchyDependentsOfDeletedFiles(relPaths: readonly RelPath[]): Promise<void> {
    if (relPaths.length === 0) return;
    const placeholders = relPaths.map(() => "?").join(", ");
    const declared = await this.session.queryAll<{ fq_name: string }>(
      `SELECT DISTINCT fq_name FROM cg_symbols WHERE rel_path IN (${placeholders})`,
      [...relPaths],
    );
    if (declared.length === 0) return;
    const deleted = new Set<string>(relPaths);
    const names = new Set(declared.map((r) => r.fq_name));
    const dependencies = await this.session.queryAll<{ source_rel_path: string; descendant_names: string }>(
      "SELECT source_rel_path, descendant_names FROM cg_hierarchy_dependencies",
    );
    const dependents = new Set<string>();
    for (const row of dependencies) {
      if (deleted.has(row.source_rel_path) || dependents.has(row.source_rel_path)) continue;
      if (decodeDescendantNames(row.descendant_names).some((name) => names.has(name))) {
        dependents.add(row.source_rel_path);
      }
    }
    if (dependents.size === 0) return;
    const targets = [...dependents];
    await this.session.run(
      `UPDATE cg_symbols_files SET content_hash = NULL WHERE rel_path IN (${targets.map(() => "?").join(", ")})`,
      targets,
    );
  }

  /**
   * The persisted pass-1 aggregate rows of `scope`'s languages, for the run-state
   * hydration at the pass-1→pass-2 barrier (bd tea-rags-mcp-znxg8). Once per run;
   * the language filter runs in SQL so a foreign language's JSON is never parsed.
   * A scan, not an index lookup — the table carries no secondary index because
   * nothing else reads it.
   */
  async listPass1Aggregates(scope: Pass1AggregateReadScope): Promise<CodegraphPass1FileAggregates[]> {
    const select = `SELECT ${CG_PASS1_DEF_COLUMNS.join(", ")} FROM cg_pass1_aggregates`;
    if (scope.kind === "allLanguages") {
      return (await this.session.queryAll<CgPass1AggregatesRow>(select)).map(fromCgPass1Row);
    }
    if (scope.languages.length === 0) return [];
    const placeholders = scope.languages.map(() => "?").join(", ");
    const rows = await this.session.queryAll<CgPass1AggregatesRow>(`${select} WHERE language IN (${placeholders})`, [
      ...scope.languages,
    ]);
    return rows.map(fromCgPass1Row);
  }

  /**
   * Drops the class sets no residual row names any more, then adds this
   * group's. A key the group stores is never deleted in the same transaction:
   * a delete and re-insert of one key is the shape DuckDB aborts on (see
   * {@link DuckDbGraphSession#applyScopedRowDiff}).
   */
  private async storeResidualClassSets(classSets: ReadonlyMap<string, string>): Promise<void> {
    const keys = [...classSets.keys()];
    await this.session.run(
      `DELETE FROM cg_residual_class_sets
        WHERE set_key NOT IN (SELECT class_set FROM cg_residual_call_sites WHERE class_set IS NOT NULL)
          AND set_key NOT IN (${keys.map(() => "?").join(", ")})`,
      keys,
    );
    await this.session.insertOrIgnoreBatched("cg_residual_class_sets", ["set_key", "class_targets"], [...classSets]);
  }

  /** Drops the class sets no residual row names any more; a removal only deletes, so no key comes back. */
  private async pruneResidualClassSets(): Promise<void> {
    await this.session.exec(
      `DELETE FROM cg_residual_class_sets
        WHERE set_key NOT IN (SELECT class_set FROM cg_residual_call_sites WHERE class_set IS NOT NULL)`,
    );
  }

  async removeFile(relPath: RelPath): Promise<void> {
    // Every table of the removed-file cascade (see REMOVED_FILE_EDGE_TABLES),
    // in one transaction so a partial failure leaves the DB consistent.
    return this.session.transaction(async () => {
      for (const table of REMOVED_FILE_EDGE_TABLES) {
        await this.session.run(`DELETE FROM ${table} WHERE source_rel_path = ? OR target_rel_path = ?`, [
          relPath,
          relPath,
        ]);
      }
      for (const table of REMOVED_FILE_SOURCE_TABLES) {
        await this.session.run(`DELETE FROM ${table} WHERE source_rel_path = ?`, [relPath]);
      }
      for (const table of REMOVED_FILE_REL_PATH_TABLES) {
        await this.session.run(`DELETE FROM ${table} WHERE rel_path = ?`, [relPath]);
      }
      await this.pruneResidualClassSets();
    });
  }

  /**
   * Set-based {@link removeFile} over many paths (bd tea-rags-mcp-b4drg): the
   * rows it removes are exactly the union of `removeFile(p)` per path, in ONE
   * transaction and one DELETE per table and direction instead of twelve per
   * path. Measured on 2716 deleted taxdome files: 18.8 s per path (5432 daemon
   * round trips) against ~1 s here.
   *
   * The paths go into a temp table and each DELETE semi-joins it, so a large
   * set costs one scan per table rather than one per chunk of an `IN` list. An
   * edge table takes two DELETEs — by source, then by target — because a
   * `source OR target` predicate cannot use either column's index.
   *
   * DELETE-only by design: no row is re-inserted in this transaction, so it
   * cannot form the delete-then-insert-of-the-same-key shape that aborts a
   * DuckDB commit (see {@link writeFileRowsBulk}). A caller that re-walks a
   * removed path does so in a later transaction.
   */
  async removeFiles(relPaths: readonly RelPath[]): Promise<void> {
    const unique = [...new Set(relPaths)];
    if (unique.length === 0) return;
    const removed = `(SELECT rel_path FROM ${REMOVED_PATHS_TEMP_TABLE})`;
    return this.session.transaction(async () => {
      await this.session.exec(`CREATE OR REPLACE TEMP TABLE cg_removed_rel_paths (rel_path VARCHAR NOT NULL)`);
      await this.session.insertBatched(
        REMOVED_PATHS_TEMP_TABLE,
        ["rel_path"],
        unique.map((relPath) => [relPath]),
      );
      for (const table of REMOVED_FILE_EDGE_TABLES) {
        await this.session.exec(`DELETE FROM ${table} WHERE source_rel_path IN ${removed}`);
        await this.session.exec(`DELETE FROM ${table} WHERE target_rel_path IN ${removed}`);
      }
      for (const table of REMOVED_FILE_SOURCE_TABLES) {
        await this.session.exec(`DELETE FROM ${table} WHERE source_rel_path IN ${removed}`);
      }
      for (const table of REMOVED_FILE_REL_PATH_TABLES) {
        await this.session.exec(`DELETE FROM ${table} WHERE rel_path IN ${removed}`);
      }
      await this.pruneResidualClassSets();
      await this.session.exec(`DROP TABLE ${REMOVED_PATHS_TEMP_TABLE}`);
    });
  }

  async listFileContentHashes(): Promise<{ relPath: RelPath; contentHash: string | null }[]> {
    const rows = await this.session.queryAll<{ rel_path: string; content_hash: string | null }>(
      "SELECT rel_path, content_hash FROM cg_symbols_files",
    );
    return rows.map((r) => ({ relPath: r.rel_path, contentHash: r.content_hash }));
  }

  async hasData(): Promise<boolean> {
    const rows = await this.session.queryAll<{ n: number }>("SELECT COUNT(*) AS n FROM cg_symbols_files");
    return Number(rows[0]?.n ?? 0) > 0;
  }
}
