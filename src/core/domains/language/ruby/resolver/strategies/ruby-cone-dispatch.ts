import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type DispatchEdge,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import { CONE_MAX_DEFAULT, lastConstantSegment, resolveConstant, type ResolverConfig } from "./shared.js";

/**
 * CHA devirtualization fan-out for polymorphic Ruby receivers (bd
 * tea-rags-mcp-2jet, variant A). A call `recv.m` whose receiver carries a
 * walker-inferred local type `T` (e.g. `agent: Agent`) does not resolve to a
 * single target when `T` has STI/mixin subclasses overriding `m` — runtime
 * dispatch could land on any of them. Rather than emit one imprecise base edge
 * (the `localType` pass) or drop, the cone fans the call out to the subclasses
 * that actually override `m`.
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
 * `K` = `cfg.coneMax` (env `CODEGRAPH_RB_CONE_MAX`, default 8). The `> K` edge is
 * expanded back to the full subtype set at query time by `get_callers` /
 * `get_callees` via the reverse index, bounding persisted edge count.
 *
 * Invariant: an `external` / unbound receiver carries no `localBinding`, so `T`
 * is undefined and the cone returns `[]` — external receivers never cone.
 */
export class RubyConeDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    if (!call.receiver) return [];
    const baseType = ctx.localBindings?.[call.receiver];
    if (!baseType || !ctx.hierarchy) return [];

    // Direct subtypes of `T`; dedup by source name (a transitive view could
    // repeat a class across depths).
    const subtypes = new Set<string>();
    for (const edge of ctx.hierarchy.getDescendants(baseType)) subtypes.add(edge.sourceFqName);

    // Keep only subtypes that DIRECTLY override `m` (a method-level pin) — an
    // inheriting subtype that doesn't redefine `m` adds no new target.
    const overrides: SymbolResolutionTarget[] = [];
    for (const subtype of subtypes) {
      const target = this.findDirectMethod(subtype, call.member, ctx);
      if (target) overrides.push(target);
    }

    const n = overrides.length;
    if (n === 0) return [];

    const coneMax = this.cfg.coneMax ?? CONE_MAX_DEFAULT;
    if (n <= coneMax) {
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
   * Method-level pin of `<typeName>#<member>` declared DIRECTLY on `typeName`'s
   * own file (no ancestor walk — an override is a direct redefinition).
   * `null` when the type's file is unknown or the method isn't declared there.
   */
  private findDirectMethod(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const file = resolveConstant(typeName, ctx);
    if (!file) return null;
    const bareType = lastConstantSegment(typeName);
    const candidates = ctx.symbolTable.lookupByShortName(member).filter((def) => {
      if (def.relPath !== file) return false;
      const tail = def.scope[def.scope.length - 1];
      return tail === typeName || tail === bareType;
    });
    const target = pickSingleCandidate(candidates, this.cfg.mode);
    return target ? { targetRelPath: target.relPath, targetSymbolId: target.symbolId } : null;
  }

  /**
   * Base-declaration target for the `poly-base` edge: `T#m` pinned method-level
   * when `T` declares `m`, else a file-only edge to `T`'s file (the method is
   * inherited / external but the file anchors query-time expansion).
   */
  private resolveBaseDecl(typeName: string, member: string, ctx: CallContext): SymbolResolutionTarget | null {
    const direct = this.findDirectMethod(typeName, member, ctx);
    if (direct) return direct;
    const file = resolveConstant(typeName, ctx);
    return file ? { targetRelPath: file, targetSymbolId: null } : null;
  }
}
