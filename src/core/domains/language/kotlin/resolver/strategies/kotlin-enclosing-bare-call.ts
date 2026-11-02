import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupKotlinSameFileMember, type ResolverConfig } from "./shared.js";

/**
 * Bare `paint()` inside a type body. Kotlin resolves an unqualified call to
 * a member of the enclosing type before a file-level function of the same
 * name, so this pass runs before `sameFileFunction`. Receiver-present calls
 * are not members reached through implicit `this`; they continue.
 * On a miss, continue — the name may be a top-level function in this file.
 */
export class KotlinEnclosingBareCallSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "enclosingBareCall";
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== null || ctx.callerScope.length === 0) return CONTINUE;
    const hit = lookupKotlinSameFileMember(ctx.callerScope, call.member, ctx);
    return hit ? resolved(hit) : CONTINUE;
  }
}
