import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import { pickSingleCandidate, type CallContext, type CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { mapBashSourceToFile, type ResolverConfig } from "./shared.js";

/**
 * Global short-name lookup for bare Bash function calls. Bash functions are
 * global within the sourced file set, so a bare call (`do_thing`) resolves by
 * short-name across every known file:
 *
 *   - Unique match → resolve it (strict mode keeps the N=1 guarantee; legacy
 *     `first` mode takes any candidate via `pickSingleCandidate`).
 *   - Ambiguous (N>1, only reachable in strict mode) → narrow to the files this
 *     caller actually sources (its `imports` list mapped through
 *     `mapBashSourceToFile`). A unique pick after the filter wins; sourcing two
 *     files that both declare `cleanup()` is still ambiguous → CONTINUE.
 *   - No match / unresolved ambiguity → CONTINUE (both original `return null`
 *     paths are terminal fall-throughs, NOT guard drops).
 *
 * This is the sole resolution pass for Bash — the single if-ladder of the
 * original `BashCallResolver.resolve`.
 */
export class BashGlobalShortNameSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "globalShortName";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const fallback = ctx.symbolTable.lookupByShortName(call.member);
    const unique = pickSingleCandidate(fallback, this.cfg.mode);
    if (unique) {
      return resolved({ targetRelPath: unique.relPath, targetSymbolId: unique.symbolId });
    }
    // Multi-source case (only reachable in strict mode): filter to
    // files that are sourced by this caller (via the imports list).
    // After the filter we still demand a unique pick — sourcing two
    // files that both declare `cleanup()` is still ambiguous.
    if (fallback.length > 1) {
      const sourcedFiles = ctx.imports.map((imp) => mapBashSourceToFile(imp.importText, ctx.callerFile));
      const candidates = fallback.filter((def) => sourcedFiles.includes(def.relPath));
      const sourced = pickSingleCandidate(candidates, this.cfg.mode);
      if (sourced) {
        return resolved({ targetRelPath: sourced.relPath, targetSymbolId: sourced.symbolId });
      }
    }
    return CONTINUE;
  }
}
