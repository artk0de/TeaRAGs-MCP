import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Global short-name fallback — bare top-level function calls (no receiver) and
 * any call that reached the end of the chain. `pickSingleCandidate(mode)`
 * returns the sole hit (strict) or the first hit (legacy `first` mode). On a
 * non-decisive result (no candidates, or ambiguous under strict mode) continue
 * — as the LAST strategy in the chain this exhausts to `null`, the original
 * terminal `return null`.
 */
export class PythonGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
