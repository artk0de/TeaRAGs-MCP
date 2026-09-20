/**
 * Custody of the file-node tables: `cg_symbols_files` plus everything keyed by
 * `source_rel_path` (file edges, method edges, inheritance, ambiguous fan-out)
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
  CodegraphPass1FileAggregates,
  GraphEdges,
  GraphFileNode,
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
import type { DuckDbGraphSession } from "./graph-session.js";

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
const FILE_EDGE_VALUES = ["import_text"] as const;
const METHOD_EDGE_KEYS = [
  "source_symbol_id",
  "source_rel_path",
  "call_expression",
  "target_rel_path",
  "target_symbol_key",
] as const;
const METHOD_EDGE_VALUES = ["target_symbol_id", "edge_kind", "confidence"] as const;
const INHERITANCE_KEYS = ["source_fq_name", "source_rel_path", "ancestor_fq_name", "kind"] as const;
const INHERITANCE_VALUES = ["source_symbol_id", "ancestor_symbol_id", "ordinal"] as const;
const FANOUT_KEYS = ["source_symbol_id", "call_expression"] as const;
const FANOUT_VALUES = ["source_rel_path", "member", "candidate_count"] as const;

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
    const pass1Rows: unknown[][] = [];
    for (const { node, edges } of group) {
      // A file may re-import the same module on different lines, so the same
      // (source, target) can arrive twice in one extraction — the diff keeps
      // the first, matching the INSERT OR IGNORE this replaced.
      for (const e of edges.fileEdges) fileEdgeRows.push([node.relPath, e.targetRelPath, e.importText]);
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
      // (source, call_expression) is aggregate-existence, not occurrence count.
      for (const a of edges.ambiguousFanouts ?? []) {
        fanoutRows.push([a.sourceSymbolId, a.callExpression, node.relPath, a.member, a.candidateCount]);
      }
      // The pass-1 slice, keyed by the NODE's path rather than the slice's own,
      // so the row can only ever land under the file being written.
      if (edges.pass1Aggregates !== undefined) {
        pass1Rows.push(toCgPass1Row({ ...edges.pass1Aggregates, relPath: node.relPath }));
      }
    }

    await this.session.applyScopedRowDiff(
      "cg_symbols_files",
      "rel_path",
      relPaths,
      ["rel_path"],
      ["language", "content_hash"],
      group.map((e) => [e.node.relPath, e.node.language, e.node.contentHash ?? null]),
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
  }

  /**
   * Every persisted pass-1 aggregate row, for the run-state hydration at the
   * pass-1→pass-2 barrier (bd tea-rags-mcp-znxg8). Whole-table read, once per
   * run — the sibling of `DuckDbSymbolStore#listAllSymbols`, and the reason the
   * table carries no secondary index.
   */
  async listAllPass1Aggregates(): Promise<CodegraphPass1FileAggregates[]> {
    const rows = await this.session.queryAll<CgPass1AggregatesRow>(
      `SELECT ${CG_PASS1_DEF_COLUMNS.join(", ")} FROM cg_pass1_aggregates`,
    );
    return rows.map(fromCgPass1Row);
  }

  async removeFile(relPath: RelPath): Promise<void> {
    // DuckDB rejects ON DELETE CASCADE; emulate manually. Order matters —
    // delete every edge that references this rel_path (as source OR
    // target), then delete the file row itself. Wrapped in a transaction
    // so a partial failure leaves the DB consistent.
    return this.session.transaction(async () => {
      await this.session.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ? OR target_rel_path = ?", [
        relPath,
        relPath,
      ]);
      await this.session.run("DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ? OR target_rel_path = ?", [
        relPath,
        relPath,
      ]);
      await this.session.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [relPath]);
      await this.session.run("DELETE FROM cg_ambiguous_fanout WHERE source_rel_path = ?", [relPath]);
      await this.session.run("DELETE FROM cg_symbols WHERE rel_path = ?", [relPath]);
      await this.session.run("DELETE FROM cg_pass1_aggregates WHERE rel_path = ?", [relPath]);
      // The file's resolve tallies (bd tea-rags-mcp-xpmwg): `getRunStats` sums
      // them per language, so a deleted file's calls must stop counting.
      await this.session.run("DELETE FROM cg_file_resolve_stats WHERE rel_path = ?", [relPath]);
      await this.session.run("DELETE FROM cg_symbols_files WHERE rel_path = ?", [relPath]);
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
