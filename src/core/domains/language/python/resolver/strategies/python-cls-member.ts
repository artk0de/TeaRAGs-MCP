import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import {
  pythonEnclosingClass,
  resolvePythonInheritedMember,
  walkClassExtendsForMethod,
  type ResolverConfig,
} from "./shared.js";

/**
 * `cls.<member>()` — the class-object twin of `selfMember` (bd
 * tea-rags-mcp-w205u, E4.4). A `cls` receiver inside a class body IS the
 * enclosing class, so the question is `selfMember`'s with one difference that
 * matters: `classifyMethod` files a `@classmethod` as `Cls.m` and an
 * undecorated `def` as `Cls#m`, and all 34 measured rows want the first. Hence
 * `spellingOrder: "classFirst"` rather than a lookup of its own — the instance
 * spelling is still ACCEPTED, because `cls.instance_method` is legal Python and
 * declining it would buy 0 measured rows.
 *
 * **Why a strategy of its own and not a widened `selfMember` predicate.** The
 * two idioms differ in preferred spelling, in precision evidence and in
 * terminality, and `answeredBy` has to be able to tell them apart in the A/B.
 *
 * **The precision gate is three facts already on the context**, because
 * `CallContext` carries no decorator channel and this increment adds no walker
 * field: an enclosing class must exist, `cls` must not be a name the walker
 * BOUND here (a `for cls in classes:` loop variable is the one shape that makes
 * `cls` not the class), and the MRO must own the member. The binding check is
 * PRESENCE in `localBindings` / `callResultBindings`, not the binding nearest
 * the call — deliberately, because that is `classifyReceiverKind`'s own test
 * (`receiver-kind.ts:71`), so the rows this pass admits are exactly the
 * `dynamic` population the residual dumps measured, and a chunk that rebinds
 * `cls` anywhere declines whichever side of the rebinding the call sits on.
 *
 * **Not a guard.** `super` and `selfMember` DROP on a closed hierarchy so a
 * miss cannot fall to `globalShortName` and fabricate. The same argument fits
 * `cls`, but the bar is gross `lost` 0 and a residual dump cannot show what
 * `globalShortName` answers CORRECTLY on `cls.` receivers today, so it was
 * MEASURED rather than argued: a DROP variant run against all five corpora
 * moved not one row and not one edge — every `cls.` receiver this pass misses
 * is one every later pass declines too. The guard is therefore free, and it is
 * still not taken: free is not the same as load-bearing, and a terminal verdict
 * adopted on an argument is the E4.1.3 mistake in a smaller frame. This pass
 * resolves or CONTINUEs; the day a later pass starts answering `cls.`, the
 * measurement is what says so.
 */
export class PythonClsMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "clsMember";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "cls") return CONTINUE;
    if (clsIsBoundHere(ctx)) return CONTINUE;
    // The enclosing class, addressed the way the run keys classes — NOT the
    // whole of `callerScope`, which carries the enclosing `def` for a call made
    // from a nested one (bd tea-rags-mcp-graiw).
    const enclosing = pythonEnclosingClass(ctx);
    if (enclosing === null) return CONTINUE;
    // An index written by walker v2 carries no `classAncestors` at all. Keep
    // the pre-seam single-base walk for it rather than answering from an empty
    // map; its miss is a CONTINUE here for the same reason the MRO's is.
    const linearizer = this.linearizers?.for(ctx);
    if (linearizer === undefined) {
      const legacy = walkClassExtendsForMethod(enclosing.name, call.member, ctx, this.cfg.mode);
      return legacy ? resolved(legacy) : CONTINUE;
    }
    const { target } = resolvePythonInheritedMember(enclosing.key, call.member, ctx, this.cfg.mode, linearizer, {
      spellingOrder: "classFirst",
    });
    return target ? resolved(target) : CONTINUE;
  }
}

/** Did the walker bind a VALUE to the name `cls` in this chunk? Then it is not the class. */
function clsIsBoundHere(ctx: CallContext): boolean {
  const local = ctx.localBindings;
  if (local !== undefined && Object.prototype.hasOwnProperty.call(local, "cls")) return true;
  const calls = ctx.callResultBindings;
  return calls !== undefined && Object.prototype.hasOwnProperty.call(calls, "cls");
}
