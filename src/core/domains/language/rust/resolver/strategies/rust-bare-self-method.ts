import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupEnclosingMember, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-c5by — bare `helper()` inside an impl block is shorthand for
 * `self.helper()` (instance) or an associated function of the enclosing type.
 * Probe the enclosing-type lookup FIRST so a global collision (e.g. `helper` on
 * both Worker and Other) doesn't misroute. Mirrors java-resolver's bare-call
 * branch. On a same-file miss, continue to the global short-name fallback — it
 * is never a drop.
 */
export class RustBareSelfMethodSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "bareSelfMethod";
  // Same-file lookups only — no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
