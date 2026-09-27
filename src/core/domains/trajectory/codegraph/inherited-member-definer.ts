/**
 * Host-class member aliasing (bd tea-rags-mcp-63l69 part 1).
 *
 * A member contributed by a mixin, concern or superclass is keyed by its
 * DEFINER — `Account::Suspensions.suspended`, not `Account.suspended` — so a
 * graph query naming the HOST class finds no node. This policy answers which
 * definer the host id denotes, reading only the persisted hierarchy
 * (`cg_symbols_inheritance` via `getSupertypes`) and the symbol table: no alias
 * rows, no walker change, and nothing language-specific — any language whose
 * hierarchy rows exist gets the same walk.
 *
 * Order is `MapHierarchyView`'s ordered transitive walk — both read
 * `compareMroPosition`: at each type its rows by MRO rank (prepend ▸
 * include/extend ▸ implements ▸ super), then declaration ordinal in the kind's
 * direction (a later mixin sits nearer, a base list reads as written), and each
 * ancestor's own ancestors right after it — so a module an included concern
 * pulls in is consulted before the host's superclass. The first ancestor
 * defining `<ancestor><sep><member>` wins. Two definers under the same parent
 * whose positions compare equal have no MRO order between them, so the answer
 * is "no alias" rather than a guess.
 */

import { splitMethodSymbol } from "../../../adapters/duckdb/symbol-id-text.js";
import type { GraphDbClient, SymbolId } from "../../../contracts/types/codegraph.js";
import { compareMroPosition, type MroPosition } from "./hierarchy-view.js";

/** The two graph reads the walk needs — direct ancestors and symbol presence. */
export type InheritedMemberGraph = Pick<GraphDbClient, "getSupertypes" | "getSymbolVisibilities">;

/** One ancestor in MRO order, with the position that orders it under its parent. */
interface MroAncestor extends MroPosition {
  fqName: string;
  parent: string;
}

/**
 * The definer symbolId a host-class `symbolId` aliases onto, or `null` when
 * there is nothing to alias: the id has no member segment, has its own node,
 * no ancestor defines the member, or the first definers are tied.
 */
export async function resolveInheritedMemberDefiner(
  graph: InheritedMemberGraph,
  symbolId: SymbolId,
): Promise<SymbolId | null> {
  const split = splitMethodSymbol(symbolId);
  if (!split) return null;
  const ancestors = await linearizeAncestors(graph, split.base);
  if (ancestors.length === 0) return null;

  const idOf = (a: MroAncestor): SymbolId => `${a.fqName}${split.sep}${split.member}`;
  const rows = await graph.getSymbolVisibilities([symbolId, ...ancestors.map(idOf)]);
  const defined = new Set(rows.map((r) => r.symbolId));
  if (defined.has(symbolId)) return null;

  const definers = ancestors.filter((a) => defined.has(idOf(a)));
  const [first] = definers;
  if (first === undefined) return null;
  const tied = definers.some((a) => a !== first && a.parent === first.parent && compareMroPosition(a, first) === 0);
  return tied ? null : idOf(first);
}

/** Every ancestor of `owner`, once, in MRO order; cycle-safe. */
async function linearizeAncestors(graph: InheritedMemberGraph, owner: string): Promise<MroAncestor[]> {
  const out: MroAncestor[] = [];
  const seen = new Set<string>([owner]);
  const visit = async (node: string): Promise<void> => {
    const edges = (await graph.getSupertypes(node))
      .map((e): MroAncestor => ({ fqName: e.ancestorFqName, parent: node, kind: e.kind, ordinal: e.ordinal ?? 0 }))
      .sort(compareMroPosition);
    for (const ancestor of edges) {
      if (seen.has(ancestor.fqName)) continue;
      seen.add(ancestor.fqName);
      out.push(ancestor);
      await visit(ancestor.fqName);
    }
  };
  await visit(owner);
  return out;
}
