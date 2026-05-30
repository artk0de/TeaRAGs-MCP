import type {
  CallContext,
  CallRef,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Intra-class `this.X()` — same-file lookup of `<EnclosingClass>#X`. Both `#`
 * (instance) and `.` (static) forms are checked because `this.staticHelper` is
 * unusual but legal. Captures intra-class calls that would otherwise be dropped
 * (`this` has no entry in `ctx.imports`). On miss, continue — `this.X` not
 * found in its own file defers to later passes, it is never a drop.
 */
export class TSThisMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  // Same-file lookups only — no tsconfig paths, no ambiguous-mode pick.
  constructor(_cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "this" || ctx.callerScope.length === 0) return CONTINUE;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];

    const fqName = `${enclosing}#${call.member}`;
    const direct = ctx.symbolTable.lookup(fqName).find((def) => def.relPath === ctx.callerFile);
    if (direct) return resolved({ targetRelPath: direct.relPath, targetSymbolId: direct.symbolId });

    // Static dispatch within the class — `this.staticHelper` is unusual but
    // legal; the target symbolId then uses `.`.
    const staticFqName = `${enclosing}.${call.member}`;
    const staticHit = ctx.symbolTable.lookup(staticFqName).find((def) => def.relPath === ctx.callerFile);
    if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });

    // Class instance shadowed via getter / decorator / mixin: fall back to
    // short-name lookup within the same file, which still beats global
    // ambiguity.
    const sameFile = ctx.symbolTable.lookupByShortName(call.member).find((def) => def.relPath === ctx.callerFile);
    if (sameFile) return resolved({ targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId });

    return CONTINUE;
  }
}
