import type { CallContext, CallRef, DispatchEdge, SymbolResolutionTarget } from "../../contracts/types/codegraph.js";
import { resolveLocalBindingType } from "../../contracts/types/codegraph.js";
import type { ConeTypeLocator, DispatchResolverComponent } from "../../contracts/types/language.js";

/**
 * Language-neutral CHA devirtualization fan-out for polymorphic receivers (bd
 * tea-rags-mcp-2jet / f10y). A call `recv.m` whose receiver carries a
 * walker-inferred local type `T` (e.g. `agent: Agent`) does not resolve to a
 * single target when `T` has subtypes overriding `m` — runtime dispatch could
 * land on any of them. Rather than emit one imprecise base edge or drop, the
 * cone fans the call out to the subtypes that actually override `m`.
 *
 * This is a **fan-out** (N edges), so it implements `DispatchResolverComponent`
 * (`resolveDispatch → DispatchEdge[]`) — NOT the single-target
 * `SymbolResolutionStrategy` chain, which cannot express N targets. The provider
 * tries `resolveDispatch` BEFORE the exact `resolve` chain and falls back to it
 * when the cone is empty (`[]`):
 *
 *   cone = getDescendants(T) ∩ { subtypes directly overriding m }
 *     |cone| == 0     → []                        (not polymorphic — exact path)
 *     |cone| ≤ K      → N edges kind='cone' confidence=1/N
 *     |cone| >  K      → 1 edge to base-decl T#m kind='poly-base' confidence=1
 *
 * `K` = `coneMax` (per-language env, e.g. `CODEGRAPH_RB_CONE_MAX`, default 8).
 * The `> K` edge is expanded back to the full subtype set at query time by
 * `get_callers` / `get_callees` via the reverse index, bounding persisted edge
 * count.
 *
 * The two language-specific operations — resolve a type name → file, and find a
 * method declared directly on a type — are injected as a `ConeTypeLocator`. The
 * engine itself is language-neutral and OWNS the poly-base policy (the
 * `findDirectMethod(T,m) ?? file-only` composition) so no language's base-decl
 * assumption leaks into this shared core.
 *
 * Invariant: an `external` / unbound receiver carries no `localBinding`, so `T`
 * is undefined and the cone returns `[]` — external receivers never cone.
 */
export class ConeDispatchResolver implements DispatchResolverComponent {
  constructor(
    private readonly locator: ConeTypeLocator,
    private readonly coneMax: number,
  ) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    if (!call.receiver) return [];
    const baseType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine);
    if (!baseType || !ctx.hierarchy) return [];

    // Direct subtypes of `T`; dedup by source name (a transitive view could
    // repeat a class across depths).
    const subtypes = new Set<string>();
    for (const edge of ctx.hierarchy.getDescendants(baseType)) subtypes.add(edge.sourceFqName);

    // Keep only subtypes that DIRECTLY override `m` (a method-level pin) — an
    // inheriting subtype that doesn't redefine `m` adds no new target.
    const overrides: SymbolResolutionTarget[] = [];
    for (const subtype of subtypes) {
      const target = this.locator.findDirectMethod(subtype, call.member, ctx);
      if (target) overrides.push(target);
    }

    const n = overrides.length;
    if (n === 0) return [];

    if (n <= this.coneMax) {
      const confidence = 1 / n;
      return overrides.map((target) => ({
        sourceSymbolId: null,
        targetRelPath: target.targetRelPath,
        targetSymbolId: target.targetSymbolId,
        edgeKind: "cone",
        confidence,
      }));
    }

    // Over the cone cap — persist one edge to the base declaration; query-time
    // expansion re-derives the full subtype set via the reverse index.
    const base = this.resolveBaseDecl(baseType, call.member, ctx);
    if (!base) return [];
    return [
      {
        sourceSymbolId: null,
        targetRelPath: base.targetRelPath,
        targetSymbolId: base.targetSymbolId,
        edgeKind: "poly-base",
        confidence: 1,
      },
    ];
  }

  /**
   * Base-declaration target for the `poly-base` edge: `T#m` pinned method-level
   * when `T` declares `m`, else a file-only edge to `T`'s file (the method is
   * inherited / external but the file anchors query-time expansion). The engine
   * owns this composition — it is language-neutral policy, not a locator
   * primitive.
   */
  private resolveBaseDecl(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const direct = this.locator.findDirectMethod(typeName, member, ctx);
    if (direct) return direct;
    const file = this.locator.resolveTypeFile(typeName, ctx);
    return file ? { targetRelPath: file, targetSymbolId: null } : null;
  }
}
