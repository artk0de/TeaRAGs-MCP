import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import {
  lookupEcmascriptSymbols,
  lookupEcmascriptSymbolsByShortName,
} from "../../../shared/ecmascript-symbol-lookup.js";
import { classBodyChunkClass, thisHierarchyAccountsFor } from "../ts-receiver-member-evidence.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Intra-class `this.X()` — same-file lookup of `<EnclosingClass>#X`. Both `#`
 * (instance) and `.` (static) forms are checked because `this.staticHelper` is
 * unusual but legal. Captures intra-class calls that would otherwise be dropped
 * (`this` has no entry in `ctx.imports`). On miss, continue — `this.X` not
 * found in its own file defers to later passes, it is never a drop.
 *
 * The enclosing class is the caller's innermost scope; a CLASS-BODY chunk (a
 * field initializer) has none, and there the chunk's own id — which carries no
 * member separator — is the class (bd tea-rags-mcp-nj8i6), so an ambiguous
 * member name in a field initializer resolves to the class's own method instead
 * of being left to the short-name tail.
 */
export class TSThisMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "thisMember";
  // Same-file lookups only — no tsconfig paths, no ambiguous-mode pick; the
  // config reaches the fallback's owner rule (the `extends` anchoring reads
  // import specifiers, so it needs the tsOptions / fileExists pair).
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "this") return CONTINUE;
    const enclosing = ctx.callerScope.at(-1) ?? classBodyChunkClass(ctx.callerSymbolId);
    if (enclosing === undefined) return CONTINUE;

    const fqName = `${enclosing}#${call.member}`;
    const direct = lookupEcmascriptSymbols(ctx, fqName).find((def) => def.relPath === ctx.callerFile);
    if (direct) return resolved({ targetRelPath: direct.relPath, targetSymbolId: direct.symbolId });

    // Static dispatch within the class — `this.staticHelper` is unusual but
    // legal; the target symbolId then uses `.`.
    const staticFqName = `${enclosing}.${call.member}`;
    const staticHit = lookupEcmascriptSymbols(ctx, staticFqName).find((def) => def.relPath === ctx.callerFile);
    if (staticHit) return resolved({ targetRelPath: staticHit.relPath, targetSymbolId: staticHit.symbolId });

    // Class instance shadowed via getter / decorator / mixin: fall back to
    // short-name lookup within the same file — but only for a candidate the
    // enclosing class OWNS: itself, or the first `extends` ancestor declaring
    // the member, every hop anchored to a file. This is the L3
    // `thisHierarchyAccountsFor` rule the evidence guard applies when IT
    // answers a `this` member (bd tea-rags-mcp-nj8i6); without it `Form`'s
    // `this.setState` landed on `Panel#setState` when both classes sat in one
    // file.
    const sameFile = lookupEcmascriptSymbolsByShortName(ctx, call.member).find(
      (def) => def.relPath === ctx.callerFile && thisHierarchyAccountsFor(call.member, ctx, this.cfg, def),
    );
    if (sameFile) return resolved({ targetRelPath: sameFile.relPath, targetSymbolId: sameFile.symbolId });

    return CONTINUE;
  }
}
