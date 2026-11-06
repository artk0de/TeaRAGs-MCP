import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { capability } from "../../capability.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Unique global short-name of the callee. Not in `KotlinCallResolver`'s chain:
 * it answers receiver-present calls, and the resolution runner synthesises
 * those from imports, so a tail here would invent file edges.
 */
export class KotlinGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const candidates = ctx.symbolTable.lookupByShortName(call.member, {
      kinds: capability.codegraph.symbolKindRoles.callee,
    });
    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
