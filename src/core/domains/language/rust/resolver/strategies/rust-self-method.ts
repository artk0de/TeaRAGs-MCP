import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupEnclosingMember, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-c5by — `self.method()` intra-impl call. Resolve to
 * `<enclosingType>#method` (instance) or `<enclosingType>.method` (associated
 * function) constrained to the caller's own file before falling through to
 * import / global short-name resolution. Mirrors the Java resolver's
 * `this.X()` branch — without this, `self.clone()` grabs the FIRST `clone`
 * from the symbol table (e.g. `Error#clone`) and produces cross-receiver
 * garbage edges. On a same-file miss, continue — `self.X` not found in its own
 * file defers to later passes, it is never a drop.
 */
export class RustSelfMethodSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMethod";
  // Same-file lookups only — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
