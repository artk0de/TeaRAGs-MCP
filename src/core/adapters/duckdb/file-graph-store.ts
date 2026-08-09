/**
 * Custody of the file-node tables: `cg_symbols_files` plus everything keyed by
 * `source_rel_path` (file edges, method edges, inheritance, ambiguous fan-out).
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

import type { GraphEdges, GraphFileNode, RelPath } from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

export class DuckDbFileGraphStore {
  constructor(private readonly session: DuckDbGraphSession) {}

  /**
   * The per-file node + edge + inheritance + ambiguous-fanout write body — the
   * DELETE+INSERT lifecycle scoped by `source_rel_path`, WITHOUT the surrounding
   * transaction. Shared by `upsertFile` (one BEGIN/COMMIT per file) and
   * `upsertFilesBulk` (one BEGIN/COMMIT per M files) so both persist identical rows.
   */
  async writeFileRows(node: GraphFileNode, edges: GraphEdges): Promise<void> {
    await this.session.run(
      "INSERT OR REPLACE INTO cg_symbols_files (rel_path, language, content_hash) VALUES (?, ?, ?)",
      [node.relPath, node.language, node.contentHash ?? null],
    );
    await this.session.run("DELETE FROM cg_symbols_edges_file WHERE source_rel_path = ?", [node.relPath]);
    await this.session.run("DELETE FROM cg_symbols_edges_method WHERE source_rel_path = ?", [node.relPath]);
    // INSERT OR IGNORE: dedupe (source, target) — a file may
    // re-import the same module on different lines, producing the
    // same edge twice in one extraction batch.
    await this.session.insertOrIgnoreBatched(
      "cg_symbols_edges_file",
      ["source_rel_path", "target_rel_path", "import_text"],
      edges.fileEdges.map((e) => [node.relPath, e.targetRelPath, e.importText]),
    );
    // GraphEdges.methodEdges allows targetSymbolId=null (the
    // resolver case where an import resolves to a file but the
    // called member isn't in that file's exported symbol table).
    // The cg_symbols_edges_method PK includes target_symbol_id —
    // DuckDB enforces NOT NULL on PK columns, so we must skip
    // null-target edges at the boundary, BEFORE batching. File-level
    // reach is already captured by fileEdges; the method graph only
    // carries edges with a known target symbol.
    //
    // INSERT OR IGNORE: same call shape may repeat — e.g.
    // `this.cache.get(x)` invoked from multiple branches of the
    // same method body. collectCalls walks every call_expression
    // and emits one CallRef per occurrence; the PK
    // (source_symbol_id, call_expression, target_symbol_id) is
    // edge-existence semantics, not occurrence count.
    // edge_kind/confidence (bd 2jet) default to exact/1.0 when the
    // resolver did not mark the edge as CHA fan-out. INSERT OR IGNORE
    // keeps the first edge's provenance when the same (source, call,
    // target) tuple repeats — edge-existence semantics, not occurrence.
    await this.session.insertOrIgnoreBatched(
      "cg_symbols_edges_method",
      [
        "source_symbol_id",
        "source_rel_path",
        "target_symbol_id",
        "target_rel_path",
        "call_expression",
        "edge_kind",
        "confidence",
      ],
      edges.methodEdges
        .filter((e) => e.targetSymbolId !== null)
        .map((e) => [
          e.sourceSymbolId,
          node.relPath,
          e.targetSymbolId,
          e.targetRelPath,
          e.callExpression,
          e.edgeKind ?? "exact",
          e.confidence ?? 1.0,
        ]),
    );
    // Inheritance edges (bd tea-rags-mcp-f10y). Per-source-file delete+insert,
    // same lifecycle as the edge tables: re-walking a file replaces its rows.
    // INSERT OR IGNORE dedupes a (source, ancestor, kind) declared twice in
    // one extraction (e.g. duplicate include).
    await this.session.run("DELETE FROM cg_symbols_inheritance WHERE source_rel_path = ?", [node.relPath]);
    await this.session.insertOrIgnoreBatched(
      "cg_symbols_inheritance",
      [
        "source_fq_name",
        "source_rel_path",
        "source_symbol_id",
        "ancestor_fq_name",
        "ancestor_symbol_id",
        "kind",
        "ordinal",
      ],
      (edges.inheritance ?? []).map((e) => [
        e.sourceFqName,
        node.relPath,
        e.sourceSymbolId,
        e.ancestorFqName,
        e.ancestorSymbolId,
        e.kind,
        e.ordinal,
      ]),
    );
    // Ambiguous fan-out aggregates (bd tea-rags-mcp-f2jsb / j0pki). Same
    // per-source-file DELETE+INSERT lifecycle as the edge tables: re-walking
    // a file replaces its rows (a fan-out resolved away must not survive).
    // INSERT OR IGNORE dedupes a repeated (source, call_expression) shape —
    // aggregate-existence semantics, not occurrence count.
    await this.session.run("DELETE FROM cg_ambiguous_fanout WHERE source_rel_path = ?", [node.relPath]);
    await this.session.insertOrIgnoreBatched(
      "cg_ambiguous_fanout",
      ["source_symbol_id", "source_rel_path", "call_expression", "member", "candidate_count"],
      (edges.ambiguousFanouts ?? []).map((a) => [
        a.sourceSymbolId,
        node.relPath,
        a.callExpression,
        a.member,
        a.candidateCount,
      ]),
    );
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
