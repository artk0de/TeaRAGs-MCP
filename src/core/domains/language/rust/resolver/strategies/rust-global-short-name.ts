import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Terminal global short-name fallback — `lookupByShortName(member)` and pick
 * the sole candidate (strict mode) or the first (legacy `first` mode). This is
 * the last pass in the chain; a non-decisive result (no candidates, or
 * ambiguous under strict mode) continues and the chain exhausts to `null`.
 *
 * Asks for the callee role (bd tea-rags-mcp-jqvbn): a trait, enum, type alias
 * or constant sharing the member's name is no candidate for calling it, and
 * counting one would turn a sole function into an ambiguous pair.
 */
export class RustGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member, { role: "callee" });
    const target = pickSingleCandidate(fallback, this.cfg.mode);
    if (target) return resolved({ targetRelPath: target.relPath, targetSymbolId: target.symbolId });
    return CONTINUE;
  }
}
