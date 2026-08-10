import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { targetsExternalImport } from "../ts-external-call.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Global short-name lookup — handles default exports, ambient declarations, and
 * free calls. `pickSingleCandidate(mode)` returns the sole hit (strict) or the
 * first hit (legacy `first` mode). On a non-decisive result (no candidates, or
 * ambiguous under strict mode) continue to the import-narrowed fallback.
 *
 * The lookup key is a BARE member name, which is what makes the external guard
 * load-bearing rather than a nicety (bd tea-rags-mcp-6b3gj): `arr.push()` and
 * `console.error()` carry a member that some project symbol is very likely to
 * share, and matching it here emits an edge to code the call never reaches.
 * A call that provably leaves the project CONTINUEs instead — the later
 * type-checker passes still get their turn, and a call none of them can answer
 * ends up correctly classified external rather than silently fabricated.
 */
export class TSGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (targetsExternalImport(call, ctx, this.cfg.tsOptions)) return CONTINUE;
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const hit = pickSingleCandidate(fallback, this.cfg.mode);
    if (hit) return resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId });
    return CONTINUE;
  }
}
