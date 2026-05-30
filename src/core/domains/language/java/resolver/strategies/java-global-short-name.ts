import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Terminal global short-name fallback for bare calls (no receiver) that the
 * enclosing-class pass did not claim — Java's static-import case or a unique
 * free function. `pickSingleCandidate(mode)` returns the sole hit (strict) or
 * the first hit (legacy `first` mode). On a non-decisive result (no candidates,
 * or ambiguous under strict mode) continue — the chain then exhausts and emits
 * no edge.
 */
export class JavaGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
