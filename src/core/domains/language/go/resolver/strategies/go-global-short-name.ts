import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Step 3 — no receiver: global short-name fallback for top-level helpers
 * (`Util()`). `pickSingleCandidate(mode)` returns the sole hit (strict) or the
 * first hit (legacy `first` mode). A receiver-present call never reaches here —
 * it CONTINUEs. A non-decisive result (no candidates, or ambiguous under strict
 * mode) also CONTINUEs; exhausting the chain returns null.
 */
export class GoGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver) return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const target = pickSingleCandidate(fallback, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}
