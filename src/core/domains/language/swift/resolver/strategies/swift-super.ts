import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  type AncestorLinearizer,
} from "../../../kernel/ancestor-walk.js";
import { RunScopedMemo } from "../../../kernel/run-scoped-memo.js";
import { SWIFT_ANCESTOR_POLICY } from "../swift-ancestor-policy.js";
import { lookupSwiftTypeMember, type SwiftResolverConfig } from "./shared.js";

/**
 * `super.X()` — the enclosing class's superclass chain, entered AFTER the class
 * itself.
 *
 * Chain index 0, and a GUARD: it resolves or it DROPs, and never continues.
 * That terminality is the whole reason the pass earns its slot. `super` is the
 * one receiver whose meaning is fixed by the language rather than inferred, so
 * a miss here is knowledge — "the project does not declare this member above
 * me" — not absence of evidence. Letting it fall through would hand the call to
 * `enclosingBareCall` and `globalShortName`, neither of which has any concept
 * of `super`, and both of which would gladly pin `super.reset()` to whatever
 * unrelated type happens to declare a `reset`. TypeScript recorded that
 * false-edge family as bd tea-rags-mcp-4rgg and Python as bd tea-rags-mcp-pic4;
 * Swift takes the verdict rather than re-measuring it.
 *
 * `startAfter: true` is the `super` semantics stated in the kernel's own
 * vocabulary: dispatch begins at the entry following the caller's class, so an
 * override calling `super` reaches the implementation it overrides instead of
 * looping back onto itself.
 *
 * Swift's own `super` has one shape — there is no two-argument form to
 * disambiguate, the way Python's `super(Cls, self)` needs — so the receiver
 * test is an equality check and not a pattern.
 */
export class SwiftSuperSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "super";

  /**
   * One linearizer per resolution context, so a file whose classes all call
   * `super` walks each hierarchy once rather than once per call site.
   *
   * Through `RunScopedMemo` rather than a bare `WeakMap`: this strategy is held
   * by a resolver that `LanguageFactory.create` caches for the factory's
   * lifetime, so a memo keyed on context identity alone would outlive the run
   * that built it — the defect bd tea-rags-mcp-z99hp records for exactly this
   * kind of cache, an ancestor linearizer, in Python.
   */
  private readonly linearizers = new RunScopedMemo<CallContext, AncestorLinearizer<CallContext>>();

  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "super") return CONTINUE;
    // A `super` call outside a type body is not expressible in Swift, so an
    // absent enclosing scope means the index disagrees with the language. DROP
    // rather than continue: the later passes would treat it as a bare call.
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    if (enclosing === undefined) return DROP;

    const scan = findMemberInAncestorChain(
      enclosing,
      this.linearizerFor(ctx),
      (candidate) => lookupSwiftTypeMember(candidate, call.member, ctx, this.cfg.mode),
      { startAfter: true },
    );
    return scan.target === null ? DROP : resolved(scan.target);
  }

  private linearizerFor(ctx: CallContext): AncestorLinearizer<CallContext> {
    const hit = this.linearizers.get(ctx.runScope, ctx);
    if (hit !== undefined) return hit;
    const fresh = createAncestorLinearizer(ctx, SWIFT_ANCESTOR_POLICY);
    this.linearizers.set(ctx.runScope, ctx, fresh);
    return fresh;
  }
}
