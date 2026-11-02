import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { isBarePhpCall, isPhpFunctionSymbol, PHP_FUNCTION_KINDS, type ResolverConfig } from "./shared.js";

/**
 * A bare call whose short name is a unique function anywhere in the table.
 * Same-file already ran, so this only answers calls that file did not own.
 * Methods are not candidates: `helper()` must not bind `Greeter#helper`.
 */
export class PhpGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (!isBarePhpCall(call.member, call.receiver)) return CONTINUE;
    const candidates = ctx.symbolTable
      .lookupByShortName(call.member, { kinds: PHP_FUNCTION_KINDS })
      .filter((def) => isPhpFunctionSymbol(def));
    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
