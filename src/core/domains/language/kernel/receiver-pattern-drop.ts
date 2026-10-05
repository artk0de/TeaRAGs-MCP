import { CONTINUE, DROP } from "../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../contracts/types/language.js";

/** One receiver-shape predicate; a match means the call's target is unknowable. */
export interface ReceiverPatternDropRule {
  name: string;
  matches: (call: CallRef, ctx: CallContext) => boolean;
}

/**
 * Catch-all guard that DROPs a call whose receiver shape makes any global
 * short-name match a false positive (drop instead of guess). Rules are tried in
 * the given order; the first match DROPs, none CONTINUEs. Language-neutral: the
 * language supplies the rules and the strategy `name`.
 */
export class ReceiverPatternDropSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    readonly name: string,
    private readonly rules: readonly ReceiverPatternDropRule[],
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    for (const rule of this.rules) {
      if (rule.matches(call, ctx)) return DROP;
    }
    return CONTINUE;
  }
}
