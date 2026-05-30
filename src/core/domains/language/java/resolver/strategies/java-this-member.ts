import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { lookupEnclosingMember, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-9t8z — `this.X()` intra-class call. Resolve to
 * `<enclosingClass>#X` (instance) or `<enclosingClass>.X` (static) constrained
 * to the caller's own file before falling through to import / global short-name
 * resolution. Mirrors the TS resolver's `this.X()` branch — without this an
 * explicit `this.helper()` was treated as receiver "this" and dropped (no
 * import matches "this", scope-filter rejects every candidate). On miss,
 * continue — `this.X` not found in its own file defers to later passes, never a
 * drop.
 */
export class JavaThisMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  // Same-file lookups only — no ambiguous-mode pick needed here.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "this" || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
