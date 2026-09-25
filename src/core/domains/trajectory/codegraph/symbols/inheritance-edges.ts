/**
 * Normalize a FileExtraction's inheritance declarations into resolved
 * InheritanceEdgeRow[] (bd tea-rags-mcp-f10y). Unifies the new `inheritanceEdges`
 * field with the legacy classExtends/classAncestors/classPrependedAncestors
 * Records, then resolves each ancestor name to an in-project symbol_id.
 *
 * `resolveAncestor` returns the symbol_id for an in-project fq name, or null for
 * external / unresolved ancestors (kept by fq name).
 *
 * The legacy Records are read ONLY for an extraction whose `inheritanceEdges`
 * field is absent — a walker that emits the field owns its whole hierarchy
 * (bd tea-rags-mcp-m1sf0). Their kind mapping is the conservative phased choice:
 *   - classExtends            → super   (single parent)
 *   - classAncestors[]        → include (Ruby mixes superclass + mixins here;
 *                               the super edge for TS/JS/Python already arrives
 *                               via classExtends, so tagging the list `include`
 *                               avoids a duplicate super)
 *   - classPrependedAncestors → prepend
 */
import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type {
  HierarchySnapshot,
  InheritanceEdgeDecl,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../../../contracts/types/codegraph.js";

export type AncestorResolver = (fqName: string) => string | null;

/**
 * Exactly the declaration fields {@link normalizeInheritanceEdges} reads — the
 * unified `inheritanceEdges` plus the three legacy Records.
 *
 * Narrowed from `FileExtraction` (which still satisfies it, so no call site
 * changed) so the persisted pass-1 slice can be normalized on the hydration path
 * too, without fabricating a `FileExtraction` around four fields
 * (bd tea-rags-mcp-znxg8). Spelled out rather than `Pick`ed because the
 * persisted slice holds its edges READONLY — the function only iterates them,
 * and a mutable array satisfies a readonly parameter but not the reverse.
 */
export interface InheritanceDeclarationSource {
  inheritanceEdges?: readonly InheritanceEdgeDecl[];
  classExtends?: Record<string, string>;
  classAncestors?: Record<string, readonly string[]>;
  classPrependedAncestors?: Record<string, readonly string[]>;
}

/**
 * Bucket resolved inheritance rows into a bidirectional `HierarchySnapshot`
 * (bd tea-rags-mcp-o17v2). The provider accumulates rows run-global during
 * pass-1 and builds this snapshot at the pass-1→pass-2 barrier so the CHA cone
 * resolver can read `getDescendants(type)` in-memory during pass-2 — without a
 * DB round-trip (inheritance edges are persisted per-file DURING pass-2, so the
 * DB is not yet complete when the first file resolves).
 */
export function buildHierarchySnapshot(rows: readonly InheritanceEdgeRow[]): HierarchySnapshot {
  const ancestorsBySource: Record<string, InheritanceEdgeRow[]> = createIdentifierRecord();
  const descendantsByAncestor: Record<string, InheritanceEdgeRow[]> = createIdentifierRecord();
  for (const r of rows) {
    (ancestorsBySource[r.sourceFqName] ??= []).push(r);
    (descendantsByAncestor[r.ancestorFqName] ??= []).push(r);
  }
  return { ancestorsBySource, descendantsByAncestor };
}

export function normalizeInheritanceEdges(
  extraction: InheritanceDeclarationSource,
  resolveAncestor: AncestorResolver,
): InheritanceEdgeRow[] {
  const out: InheritanceEdgeRow[] = [];
  const seen = new Set<string>(); // `${source}\0${ancestor}\0${kind}` dedup

  const push = (source: string, ancestor: string, kind: InheritanceKind, ordinal: number): void => {
    const key = `${source}\0${ancestor}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      sourceFqName: source,
      sourceSymbolId: resolveAncestor(source), // source is a class def — usually resolves
      ancestorFqName: ancestor,
      ancestorSymbolId: resolveAncestor(ancestor),
      kind,
      ordinal,
    });
  };

  // 1. unified field first. A walker that emits `inheritanceEdges` at all has
  //    migrated to unified capture and owns the WHOLE extraction's hierarchy —
  //    it already tags every channel with a precise kind. The legacy Records it
  //    keeps in parallel (for the resolver-forward path) would otherwise re-tag
  //    the same ancestors coarsely (Ruby flattens superclass + mixins into
  //    classAncestors → include), producing duplicate edges with conflicting
  //    kinds (bd tea-rags-mcp-lz8t).
  const unifiedEdges = extraction.inheritanceEdges;
  for (const e of unifiedEdges ?? []) push(e.source, e.ancestor, e.kind, e.ordinal);

  // 2. Ownership is per-EXTRACTION, not per-source (bd tea-rags-mcp-m1sf0).
  //    Per-source scope assumed both surfaces key sources identically; the
  //    Python walker breaks that — its `classAncestors` keys are
  //    `<relPath>::<fq>` with import-qualified values while its
  //    `inheritanceEdges` sources are bare fq, so no key ever matched and every
  //    Python class lifted one junk `include` row per base on every reindex.
  //    PRESENCE, not content, is the migration signal: an explicitly empty
  //    array means "this file declares no hierarchy", so it also suppresses the
  //    lift. Only an ABSENT field marks a walker that has not migrated.
  //    Ruby and TS emit both surfaces with bare-fq sources, so their output is
  //    unchanged (pinned by the shape fixtures in inheritance-edges.test.ts).
  if (unifiedEdges !== undefined) return out;

  for (const [src, parent] of Object.entries(extraction.classExtends ?? {})) {
    push(src, parent, "super", 0);
  }
  for (const [src, ancestors] of Object.entries(extraction.classAncestors ?? {})) {
    ancestors.forEach((a, i) => {
      push(src, a, "include", i);
    });
  }
  for (const [src, ancestors] of Object.entries(extraction.classPrependedAncestors ?? {})) {
    ancestors.forEach((a, i) => {
      push(src, a, "prepend", i);
    });
  }

  return out;
}
