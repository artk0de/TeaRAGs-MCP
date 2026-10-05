import {
  NOMINAL_INHERITANCE_KINDS,
  resolveLocalBindingType,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type DispatchFanoutOutcome,
  type InheritanceEdge,
  type SymbolResolutionTarget,
} from "../../../contracts/types/codegraph.js";
import type { ConeTypeLocator, DispatchResolverComponent } from "../../../contracts/types/language.js";

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

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchFanoutOutcome {
    // The cone is bounded by design (`coneMax` → poly-base collapse), so it
    // never yields an over-cap `ambiguous` verdict — always an edges outcome.
    return { kind: "edges", edges: this.resolveDispatchEdges(call, ctx) };
  }

  private resolveDispatchEdges(call: CallRef, ctx: CallContext): DispatchEdge[] {
    if (!call.receiver) return [];
    const baseType = resolveLocalBindingType(ctx.localBindings, call.receiver, call.startLine, call.startColumn);
    if (!baseType || !ctx.hierarchy) return [];

    // Direct subtypes of `T`; dedup by source name (a transitive view could
    // repeat a class across depths).
    const descendants = ctx.hierarchy.getDescendants(baseType);
    const subtypes = new Set<string>();
    for (const edge of descendants) subtypes.add(edge.sourceFqName);

    // Keep only subtypes that DIRECTLY override `m` (a method-level pin) — an
    // inheriting subtype that doesn't redefine `m` adds no new target. Keyed by
    // the DEFINING class so the RTA prune (below) can map an instantiated
    // type's nearest definer back to its cone member.
    const subtypeOverrides = new Map<string, SymbolResolutionTarget>();
    for (const subtype of subtypes) {
      const target = this.locator.findDirectMethod(subtype, call.member, ctx);
      if (target) subtypeOverrides.set(subtype, target);
    }
    if (subtypeOverrides.size === 0) return [];

    // The RECEIVER's own dispatch target (bd tea-rags-mcp-m99j1.1.84): an
    // instance of `T` itself lands on `T`'s declaration of `m` (or the nominal
    // ancestor's it inherits), so that declaration is a cone member beside the
    // overrides. Only for a language whose locator answers
    // `isRuntimeDispatchClass`; absent ⇒ subtypes-only, as before. Keyed by its
    // defining class, so the RTA prune keeps it exactly when an instantiated
    // type dispatches there — it prunes subclass overrides, never the receiver's
    // own resolution while `T` or a non-overriding subtype is instantiated.
    const receiverDeclaration = this.receiverDeclaration(baseType, call.member, ctx, descendants);
    const coneByDefiner =
      receiverDeclaration && !subtypeOverrides.has(receiverDeclaration.definer)
        ? new Map([[receiverDeclaration.definer, receiverDeclaration.target], ...subtypeOverrides])
        : subtypeOverrides;

    // RTA prune (bd tea-rags-mcp-pffv): keep a cone member only when it is the
    // nearest definer of `m` for some INSTANTIATED type `U <: T`. Gated on the
    // run-global instantiation set being present and non-empty — absent ⇒
    // pre-pffv full cone (the cone engine is shared across languages; only
    // Ruby populates the set initially). Soundness floor: an empty prune keeps
    // the unpruned cone (zero-evidence metaprogramming case).
    let live = coneByDefiner;
    if (ctx.instantiatedTypes && ctx.instantiatedTypes.size > 0) {
      const pruned = new Map<string, SymbolResolutionTarget>();
      for (const u of [baseType, ...subtypes]) {
        if (!ctx.instantiatedTypes.has(u)) continue;
        const definer = this.nearestDefiner(u, call.member, ctx);
        const target = definer ? coneByDefiner.get(definer) : undefined;
        if (definer && target) pruned.set(definer, target);
      }
      if (pruned.size > 0) live = pruned;
    }

    const members = [...live.values()];
    const n = members.length;
    // The cap counts OVERRIDES: the receiver's own declaration never tips a
    // cone into the `poly-base` collapse, which already targets that base.
    const overrideCount = receiverDeclaration && live.has(receiverDeclaration.definer) ? n - 1 : n;

    if (overrideCount <= this.coneMax) {
      const confidence = 1 / n;
      return members.map((target) => ({
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

  /**
   * The receiver's own dispatch target for `member` — `typeName`'s declaration,
   * else its nearest nominal ancestor's — keyed by that defining class. `null`
   * when the locator does not answer `isRuntimeDispatchClass` (the language has
   * not opted in), when no class on the MRO declares `member` in the project,
   * when `typeName` has no NOMINAL descendant (a contract reached only
   * structurally is never instantiated), or when the receiver or the defining
   * class is no runtime class (a `typing.Protocol` stub).
   */
  private receiverDeclaration(
    typeName: string,
    member: string,
    ctx: CallContext,
    descendants: readonly InheritanceEdge[],
  ): { definer: string; target: SymbolResolutionTarget } | null {
    if (!this.locator.isRuntimeDispatchClass) return null;
    const isRuntimeClass = (name: string): boolean => this.locator.isRuntimeDispatchClass?.(name, ctx) ?? false;
    if (!descendants.some((edge) => NOMINAL_INHERITANCE_KINDS.includes(edge.kind))) return null;
    if (!isRuntimeClass(typeName)) return null;
    const definer = this.nearestDefiner(typeName, member, ctx);
    if (!definer || (definer !== typeName && !isRuntimeClass(definer))) return null;
    const target = this.locator.findDirectMethod(definer, member, ctx);
    return target ? { definer, target } : null;
  }

  /**
   * The class that DEFINES `member` for an instance of `typeName`: `typeName`
   * itself if it declares `member`, else the first ancestor in MRO order that
   * does (bd tea-rags-mcp-pffv). This is the runtime dispatch target for an
   * instance of `typeName`; RTA keeps a cone member iff it is the nearest
   * definer for some instantiated type. Returns the fq class name, or null when
   * no class on the chain declares `member`.
   */
  private nearestDefiner(typeName: string, member: string, ctx: CallContext): string | null {
    if (this.locator.findDirectMethod(typeName, member, ctx)) return typeName;
    if (!ctx.hierarchy) return null;
    // Nominal kinds only (bd tea-rags-mcp-39xca.14): a structural ancestor is
    // a contract the type satisfies, never a class it inherits code from.
    const mro = ctx.hierarchy.getAncestors(typeName, {
      ordered: true,
      transitive: true,
      kinds: NOMINAL_INHERITANCE_KINDS,
    });
    for (const edge of mro) {
      if (this.locator.findDirectMethod(edge.ancestorFqName, member, ctx)) return edge.ancestorFqName;
    }
    return null;
  }
}
