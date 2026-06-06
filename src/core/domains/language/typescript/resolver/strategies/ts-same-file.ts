import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolDefinition,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { ResolverConfig } from "./shared.js";

/**
 * Same-file preference. Resolves a call whose target is defined in
 * the CALLER'S OWN file when the short-name is globally ambiguous — the case
 * `globalShortName` drops (N>1) and `importNarrowedFallback` can't recover (the
 * target is local, not imported). Lexical scope guarantees the same-file
 * definition is the real target, so this is a safe, deterministic resolve.
 *
 * Runs at chain position 8 (after the receiver/import strategies, before
 * `globalShortName`) so it is strictly additive: for a globally-unique name the
 * result is identical to `globalShortName`; for an ambiguous name it resolves
 * the same-file definition instead of dropping.
 *
 * Three call shapes:
 *   - bare call `helper()`            → same-file symbol with shortName `member`
 *   - same-file `new X()`             → `X#constructor` in the caller file
 *                                       (walker synthesizes it even when implicit)
 *   - same-file `Class.staticMember()`→ `Class.staticMember` in the caller file
 * A lowercase variable receiver (`obj.method()`) is NOT this pass's case —
 * variable typing is `localBinding` / `fieldType`'s job (they ran earlier).
 * Imported targets are NOT this pass's case — `namedImport` owns them.
 */
export class TSSameFileSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "sameFile";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver, member } = call;
    let candidates: SymbolDefinition[];

    if (receiver === null || receiver === undefined) {
      // bare call: helper()
      candidates = ctx.symbolTable.lookupByShortName(member).filter((d) => d.relPath === ctx.callerFile);
    } else if (member === "constructor" && /^[A-Z]/.test(receiver)) {
      // same-file new X(): target X#constructor in the caller file
      candidates = ctx.symbolTable
        .lookupByShortName("constructor")
        .filter((d) => d.relPath === ctx.callerFile && d.scope[d.scope.length - 1] === receiver);
    } else if (/^[A-Z]/.test(receiver)) {
      // same-file Class.staticMember()
      candidates = ctx.symbolTable
        .lookupByShortName(member)
        .filter((d) => d.relPath === ctx.callerFile && d.scope[d.scope.length - 1] === receiver);
    } else {
      // lowercase var.method() — not this pass's case
      return CONTINUE;
    }

    const hit = pickSingleCandidate(candidates, this.cfg.mode);
    return hit ? resolved({ targetRelPath: hit.relPath, targetSymbolId: hit.symbolId }) : CONTINUE;
  }
}
