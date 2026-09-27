/**
 * Sync, in-memory HierarchyView over a HierarchySnapshot (bd tea-rags-mcp-f10y).
 * Lives in infra/ so both the provider (trajectory) and any leaf consumer can
 * import it. No DB access — all reads hit the pre-loaded snapshot maps, so the
 * resolver's synchronous strategies can consult it without crossing IPC.
 */
import type {
  HierarchyQuery,
  HierarchySnapshot,
  HierarchyView,
  InheritanceEdge,
  InheritanceEdgeRow,
  InheritanceKind,
} from "../../../contracts/types/codegraph.js";

// MRO precedence: prepend (highest) ▸ include/extend ▸ implements ▸ super ▸
// structural (lowest). A structural ancestor is derived, never declared, so it
// sorts after every nominal one; MRO walks exclude it by kind anyway.
export const MRO_RANK: Record<InheritanceKind, number> = {
  prepend: 0,
  include: 1,
  extend: 1,
  implements: 2,
  super: 3,
  structural: 4,
};

// Which way the per-kind declaration ordinal runs WITHIN one rank (bd
// tea-rags-mcp-u0t4p). A mixin is inserted at the FRONT of its region, so the
// last `include` / `extend` / `prepend` declared sits nearest — `include A;
// include B` gives `[C, B, A]`, `prepend A; prepend B` gives `[B, A, C]`. A base
// list reads in the order written: Python `class C(A, B)` consults A first (C3
// itself is computed by the Python ancestor policy, not here), and `implements`
// order carries no dispatch meaning but must stay stable.
export const MRO_ORDINAL_DIRECTION: Record<InheritanceKind, 1 | -1> = {
  prepend: -1,
  include: -1,
  extend: -1,
  implements: 1,
  super: 1,
  structural: 1,
};

/** One direct ancestor's position under its source — what the MRO order compares. */
export interface MroPosition {
  kind: InheritanceKind;
  ordinal: number;
}

/**
 * Nearest-first comparator over the direct ancestors of ONE type: `MRO_RANK`
 * first, then the ordinal in the kind's `MRO_ORDINAL_DIRECTION`. Zero means
 * the two positions have no MRO order between them.
 */
export function compareMroPosition(a: MroPosition, b: MroPosition): number {
  return MRO_RANK[a.kind] - MRO_RANK[b.kind] || MRO_ORDINAL_DIRECTION[a.kind] * (a.ordinal - b.ordinal);
}

export class MapHierarchyView implements HierarchyView {
  constructor(private readonly snapshot: HierarchySnapshot) {}

  getAncestors(fqName: string, opts: HierarchyQuery = {}): readonly InheritanceEdge[] {
    return this.walk(fqName, "ancestorsBySource", (r) => r.ancestorFqName, opts);
  }

  getDescendants(fqName: string, opts: HierarchyQuery = {}): readonly InheritanceEdge[] {
    return this.walk(fqName, "descendantsByAncestor", (r) => r.sourceFqName, opts);
  }

  private walk(
    key: string,
    index: "ancestorsBySource" | "descendantsByAncestor",
    next: (r: InheritanceEdgeRow) => string,
    opts: HierarchyQuery,
  ): InheritanceEdge[] {
    const out: InheritanceEdge[] = [];
    const seen = new Set<string>();
    const visit = (node: string, depth: number): void => {
      if (seen.has(node)) return; // cycle guard (defensive — inheritance shouldn't cycle)
      seen.add(node);
      let rows = this.snapshot[index][node] ?? [];
      const { kinds } = opts;
      if (kinds) rows = rows.filter((r) => kinds.includes(r.kind));
      if (opts.ordered && index === "ancestorsBySource") {
        rows = [...rows].sort(compareMroPosition);
      }
      for (const r of rows) {
        out.push({
          sourceFqName: r.sourceFqName,
          ancestorFqName: r.ancestorFqName,
          ancestorSymbolId: r.ancestorSymbolId,
          kind: r.kind,
          depth,
        });
        if (opts.transitive) visit(next(r), depth + 1);
      }
    };
    visit(key, 1);
    return out;
  }
}
