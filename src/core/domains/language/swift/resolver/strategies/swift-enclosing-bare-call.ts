import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupEnclosingTypeMemberInFile, type SwiftResolverConfig } from "./shared.js";

/**
 * A bare `helper()` inside a type body is shorthand for `self.helper()` (or a
 * static member of the enclosing type). Probe the enclosing type in the
 * caller's own file BEFORE the global short-name fallback, so a project-wide
 * collision on a name as common as `reset` / `update` / `configure` cannot
 * misroute a call that never left its own type.
 *
 * On a same-file miss, continue — the extension-scope pass takes it next,
 * because the type's other half may live in another file. It is never a drop:
 * a bare call genuinely can be a free function, which is what the terminal
 * pass exists for.
 */
export class SwiftEnclosingBareCallSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "enclosingBareCall";
  // Same-file enclosing lookup only — no ambiguous-mode pick needed here.
  constructor(_cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null || ctx.callerScope.length === 0) return CONTINUE;
    const sameFileHit = lookupEnclosingTypeMemberInFile(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
