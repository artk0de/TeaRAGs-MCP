/**
 * Reads over `cg_symbols_inheritance` (bd tea-rags-mcp-f10y) — the class
 * hierarchy in both directions: direct ancestors by declaration ordinal, direct
 * subtypes off the reverse index, transitive subtypes via recursive CTE, and
 * the whole table pre-bucketed for the resolver's snapshot.
 *
 * The write side of this table belongs to `DuckDbFileGraphStore`: inheritance
 * rows live and die with their declaring file's `source_rel_path` slice.
 */

import type {
  HierarchySnapshot,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../contracts/types/codegraph.js";
import type { DuckDbGraphSession } from "./graph-session.js";

export class DuckDbHierarchyReader {
  constructor(private readonly session: DuckDbGraphSession) {}

  async getSupertypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.session.queryAll<{
      ancestorFqName: string;
      ancestorSymbolId: string | null;
      kind: InheritanceKind;
    }>(
      `SELECT ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind
         FROM cg_symbols_inheritance WHERE source_fq_name = ? ORDER BY ordinal, ancestor_fq_name`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: fqName,
      ancestorFqName: r.ancestorFqName,
      ancestorSymbolId: r.ancestorSymbolId,
      kind: r.kind,
      depth: 1,
    }));
  }

  async getSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.session.queryAll<{ sourceFqName: string; kind: InheritanceKind }>(
      `SELECT source_fq_name AS "sourceFqName", kind
         FROM cg_symbols_inheritance WHERE ancestor_fq_name = ? ORDER BY source_fq_name`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: r.sourceFqName,
      ancestorFqName: fqName,
      ancestorSymbolId: null,
      kind: r.kind,
      depth: 1,
    }));
  }

  async getTransitiveSubtypes(fqName: string): Promise<InheritanceEdge[]> {
    const rows = await this.session.queryAll<{
      sourceFqName: string;
      ancestorFqName: string;
      kind: InheritanceKind;
      depth: number | bigint;
    }>(
      `WITH RECURSIVE sub(source_fq_name, ancestor_fq_name, kind, depth) AS (
         SELECT source_fq_name, ancestor_fq_name, kind, 1
           FROM cg_symbols_inheritance WHERE ancestor_fq_name = ?
         UNION ALL
         SELECT c.source_fq_name, c.ancestor_fq_name, c.kind, sub.depth + 1
           FROM cg_symbols_inheritance c JOIN sub ON c.ancestor_fq_name = sub.source_fq_name
       )
       SELECT source_fq_name AS "sourceFqName", ancestor_fq_name AS "ancestorFqName", kind, depth FROM sub`,
      [fqName],
    );
    return rows.map((r) => ({
      sourceFqName: r.sourceFqName,
      ancestorFqName: r.ancestorFqName,
      ancestorSymbolId: null,
      kind: r.kind,
      depth: Number(r.depth),
    }));
  }

  async loadHierarchySnapshot(): Promise<HierarchySnapshot> {
    const rows = await this.session.queryAll<{
      sourceFqName: string;
      sourceSymbolId: string | null;
      ancestorFqName: string;
      ancestorSymbolId: string | null;
      kind: InheritanceKind;
      ordinal: number | bigint;
    }>(
      `SELECT source_fq_name AS "sourceFqName", source_symbol_id AS "sourceSymbolId",
              ancestor_fq_name AS "ancestorFqName", ancestor_symbol_id AS "ancestorSymbolId", kind, ordinal
         FROM cg_symbols_inheritance ORDER BY source_fq_name, ordinal`,
    );
    const ancestorsBySource: Record<string, InheritanceEdgeRow[]> = {};
    const descendantsByAncestor: Record<string, InheritanceEdgeRow[]> = {};
    for (const r of rows) {
      const row: InheritanceEdgeRow = {
        sourceFqName: r.sourceFqName,
        sourceSymbolId: r.sourceSymbolId,
        ancestorFqName: r.ancestorFqName,
        ancestorSymbolId: r.ancestorSymbolId,
        kind: r.kind,
        ordinal: Number(r.ordinal),
      };
      (ancestorsBySource[row.sourceFqName] ??= []).push(row);
      (descendantsByAncestor[row.ancestorFqName] ??= []).push(row);
    }
    return { ancestorsBySource, descendantsByAncestor };
  }
}
