import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupKotlinSameFileMember, type ResolverConfig } from "./shared.js";

/**
 * `this.method()` / `this.method` inside a type. The receiver text is exactly
 * `this` — a labelled `this@Outer` or a chain `this.field.method()` is not
 * this pass. On a miss, continue: the member may be a top-level function
 * only the later passes can see, and a wrong drop would hide it.
 */
export class KotlinThisMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "this" || ctx.callerScope.length === 0) return CONTINUE;
    const hit = lookupKotlinSameFileMember(ctx.callerScope, call.member, ctx);
    return hit ? resolved(hit) : CONTINUE;
  }
}
