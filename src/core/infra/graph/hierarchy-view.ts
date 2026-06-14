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
} from "../../contracts/types/codegraph.js";

// MRO precedence: prepend (highest) ▸ include/extend ▸ implements ▸ super (lowest).
const MRO_RANK: Record<InheritanceKind, number> = { prepend: 0, include: 1, extend: 1, implements: 2, super: 3 };

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
        rows = [...rows].sort((a, b) => MRO_RANK[a.kind] - MRO_RANK[b.kind] || a.ordinal - b.ordinal);
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
