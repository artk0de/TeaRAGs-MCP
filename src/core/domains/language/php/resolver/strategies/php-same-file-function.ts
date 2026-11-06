import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { isBarePhpCall, isPhpFunctionSymbol, PHP_FUNCTION_KINDS, type ResolverConfig } from "./shared.js";

/**
 * A bare `helper()` defined in the caller's file.
 *
 * Runs before `globalShortName`. Two files that both define `helper` make
 * the global lookup ambiguous, and the call would be dropped even though
 * the caller's own function is the one PHP invokes. A method named `helper`
 * in the same file is not a candidate: a bare call is not `$this->helper()`.
 *
 * No same-file function → CONTINUE. Ambiguous same-file hits (strict mode)
 * also CONTINUE; the global pass then sees the same ambiguity and emits nothing.
 */
export class PhpSameFileFunctionSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "sameFileFunction";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!isBarePhpCall(call.member, call.receiver)) return CONTINUE;
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member, { kinds: PHP_FUNCTION_KINDS })
      .filter((def) => def.relPath === ctx.callerFile && isPhpFunctionSymbol(def));
    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    return hit ? resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId }) : CONTINUE;
  }
}
