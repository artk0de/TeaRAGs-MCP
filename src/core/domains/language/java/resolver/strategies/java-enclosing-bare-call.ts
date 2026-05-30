import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { lookupEnclosingMember, type ResolverConfig } from "./shared.js";

/**
 * bd tea-rags-mcp-9t8z — implicit-receiver bare call (Java `foo()` inside a
 * class body is shorthand for `this.foo()` for instance methods, or a
 * private/static helper of the enclosing class). Try the enclosing-class lookup
 * FIRST so a global short-name collision (e.g. `append` on both
 * HashCodeBuilder and StringBuffer) doesn't drop the edge or misroute it. Only
 * fires for bare calls (no receiver) — receiver-present calls were already
 * claimed by the import-receiver guard. On miss, continue to the global
 * short-name fallback.
 */
export class JavaEnclosingBareCallSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "enclosingBareCall";
  // Same-file enclosing lookup only — no ambiguous-mode pick needed here.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingMember(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
