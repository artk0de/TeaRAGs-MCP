/**
 * Codegraph class-hierarchy contracts — the single cross-language vocabulary
 * for inheritance (`super` / `include` / `extend` / `prepend` / `implements`)
 * in its three lifecycle shapes: as the walker declares it
 * (`InheritanceEdgeDecl`), as the DB stores it (`InheritanceEdgeRow`), and as a
 * traversal returns it (`InheritanceEdge`) — plus the sync, leaf-safe read
 * surface (`HierarchyView`) the resolver consults on the pass-2 hot path.
 *
 * Imports nothing: hierarchy is keyed by fully-qualified NAME, not by
 * `SymbolId`. Re-exported verbatim by the `codegraph.ts` barrel.
 */

/**
 * Class-hierarchy edge kind (bd tea-rags-mcp-f10y). `super`/`include`/`extend`/
 * `prepend` mirror Ruby's MRO inputs; `implements` covers TS/Java interface
 * heritage (and TS `interface X extends Y`). Single vocabulary across languages.
 */
export type InheritanceKind = "super" | "include" | "extend" | "prepend" | "implements";

/**
 * Walker emission shape — one row per declared inheritance relation, BEFORE
 * name resolution. `source` / `ancestor` are raw fq/short names as written.
 * Unified surface superseding the per-kind classAncestors/classExtends/
 * classPrependedAncestors Records (which stay during the phased migration).
 */
export interface InheritanceEdgeDecl {
  source: string;
  ancestor: string;
  kind: InheritanceKind;
  ordinal: number;
}

/**
 * Persisted / resolved shape — what the normalizer produces and the DB stores
 * (minus `source_rel_path`, which the upsert supplies from `GraphFileNode`).
 * `ancestorSymbolId` is `null` for external / unresolved ancestors.
 */
export interface InheritanceEdgeRow {
  sourceFqName: string;
  sourceSymbolId: string | null;
  ancestorFqName: string;
  ancestorSymbolId: string | null;
  kind: InheritanceKind;
  ordinal: number;
}

/** Query result — a persisted inheritance edge plus traversal depth. */
export interface InheritanceEdge {
  sourceFqName: string;
  ancestorFqName: string;
  ancestorSymbolId: string | null;
  kind: InheritanceKind;
  depth: number;
}

/** Options for a {@link HierarchyView} traversal. */
export interface HierarchyQuery {
  kinds?: readonly InheritanceKind[];
  transitive?: boolean;
  /** getAncestors only: MRO order (prepend ▸ include/extend ▸ implements ▸ super). */
  ordered?: boolean;
}

/**
 * Sync, leaf-safe read surface the resolver consumes via `CallContext.hierarchy`
 * (bd tea-rags-mcp-f10y). Backed by an in-memory snapshot the provider loads at
 * the pass-1→pass-2 barrier — no DB access on the resolve path.
 */
export interface HierarchyView {
  getAncestors: (fqName: string, opts?: HierarchyQuery) => readonly InheritanceEdge[];
  getDescendants: (fqName: string, opts?: HierarchyQuery) => readonly InheritanceEdge[];
}

/**
 * Plain-data snapshot the provider loads once at the barrier; `MapHierarchyView`
 * wraps it. Both directions keyed by fqName.
 */
export interface HierarchySnapshot {
  ancestorsBySource: Record<string, InheritanceEdgeRow[]>;
  descendantsByAncestor: Record<string, InheritanceEdgeRow[]>;
}
