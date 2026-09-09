import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import { pythonClassKey, resolvePythonInheritedMember, type ResolverConfig } from "./shared.js";

/**
 * The explicit two-argument form, `super(Cls, self).m()`. The walker leaves its
 * receiver text verbatim (bd tea-rags-mcp-ntnke) because `Cls` names the class
 * the walk starts AFTER, and that is not always the enclosing class.
 */
const EXPLICIT_SUPER_RE = /^super\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)\s*,/;

/**
 * `super().X()` / `super.X()` — resolve `X` on the enclosing class's MRO,
 * starting at the position AFTER the enclosing class itself (bd
 * tea-rags-mcp-pic4, MRO walk added by tea-rags-mcp-ntnke).
 *
 * The walk used to be a single-parent `classExtends[enclosing]` hop, which
 * cannot express what `super()` means under multiple inheritance: on
 * `class C(A, B)` it saw `A` alone, so a member declared on `B` was invisible
 * however far the chain was followed. `startAfter: true` over the linearized
 * order is exactly the runtime semantics — and it is the case jedi 0.20.0
 * itself gets wrong, which is why `applySuperMroBlindSpot` withdraws jedi's
 * answer there rather than scoring us against it.
 *
 * This is the one **guard** strategy: when the receiver is `super` it is always
 * terminal — it either resolves or **drops**, never continues, whatever the
 * closure flavour says. Where `selfMember` CONTINUEs on an `unknown` boundary,
 * `super` does not: a fall-through here lands on the ambiguous short-name path,
 * which attributes `__init__` to whatever unrelated class shares the name (the
 * TS family, bd tea-rags-mcp-4rgg). The two-argument form is the one exception,
 * and it declines rather than resolving — see `resolveSuper`.
 *
 * A walker-v2 index carries no `classAncestors`; there the pre-seam
 * single-inheritance walk stays in force, byte-identically.
 */
export class PythonSuperSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "super";

  constructor(
    private readonly cfg: ResolverConfig,
    private readonly linearizers?: PythonAncestorLinearizerCache,
  ) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const { receiver } = call;
    if (receiver === null) return CONTINUE;
    const isBareSuper = receiver === "super()" || receiver === "super";
    const explicit = isBareSuper ? null : EXPLICIT_SUPER_RE.exec(receiver);
    if (!isBareSuper && explicit === null) return CONTINUE;
    // `super(Cls, self)` starts after `Cls`. Only where that IS the enclosing
    // class is the call semantically a plain `super()`; anything else names a
    // start position this pass has no answer for, so it declines instead of
    // guessing — and declining, not DROPping, because the guard's terminality
    // is earned by knowing the answer.
    if (explicit !== null && !this.namesEnclosingClass(explicit[1], ctx)) return CONTINUE;
    const target = this.resolveSuper(call.member, ctx, explicit !== null);
    if (target) return resolved(target);
    // A two-argument form on a walker-v2 index falls through: the pre-seam walk
    // starts at the single parent, which is the right answer only for `super()`.
    if (explicit !== null && this.linearizers?.for(ctx) === undefined) return CONTINUE;
    // `super` is terminal: a miss is a DROP, not a fall-through (bd pic4/4rgg).
    return DROP;
  }

  /** Does `named` — the first argument of `super(Cls, self)` — name the caller's own class? */
  private namesEnclosingClass(named: string | undefined, ctx: CallContext): boolean {
    if (named === undefined || ctx.callerScope.length === 0) return false;
    return named === ctx.callerScope.join(".") || named === ctx.callerScope[ctx.callerScope.length - 1];
  }

  /**
   * The first class AFTER the caller's own in its linearized MRO that owns
   * `member`. `null` when the caller has no enclosing class, when no ancestor
   * in the project defines the member, or when a branch of the hierarchy left
   * the project before one did — each of which the caller turns into a DROP.
   *
   * The `closure` is deliberately discarded: for `super` all three flavours
   * DROP, so there is nothing for it to decide.
   */
  private resolveSuper(member: string, ctx: CallContext, explicit: boolean): SymbolResolutionTarget | null {
    if (ctx.callerScope.length === 0) return null;
    const linearizer = this.linearizers?.for(ctx);
    // An index written by walker v2 carries no `classAncestors`. Keep the
    // pre-seam single-base walk for it — but only for the bare form, whose
    // start position that walk actually models.
    if (linearizer === undefined) return explicit ? null : this.resolveSuperViaClassExtends(member, ctx);
    // `callerScope` holds class containers only, so it IS the dotted class FQ.
    const classKey = pythonClassKey(ctx.callerFile, ctx.callerScope.join("."));
    const { target } = resolvePythonInheritedMember(classKey, member, ctx, this.cfg.mode, linearizer, {
      startAfter: true,
    });
    return target;
  }

  /**
   * The pre-seam walk, unchanged: resolve against the parent class determined
   * by `ctx.classExtends`, following the single-inheritance chain (B extends A,
   * A extends C, …) until an ancestor's file owns a symbol matching `member`.
   * Instance form preferred, static fallback.
   *
   * This is the walker-v2 fallback and its behaviour must not drift. Mirrors
   * `TSSuperSymbolResolutionStrategy.resolveSuper` (bd tea-rags-mcp-4rgg) with
   * single-inheritance Python semantics.
   */
  private resolveSuperViaClassExtends(member: string, ctx: CallContext): SymbolResolutionTarget | null {
    if (!ctx.classExtends) return null;
    const enclosing = ctx.callerScope[ctx.callerScope.length - 1];
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    const visited = new Set<string>([enclosing]);
    while (current && !visited.has(current)) {
      visited.add(current);
      // Instance form first — `super().__init__()` is an instance-method
      // dispatch by definition. Static fallback covers the unusual
      // `super().classmethod()` shape (legal Python but rare).
      const instanceFq = `${current}#${member}`;
      const instanceHit = ctx.symbolTable.lookup(instanceFq);
      const instanceTarget = pickSingleCandidate(instanceHit, this.cfg.mode);
      if (instanceTarget) {
        return { targetRelPath: instanceTarget.relPath, targetSymbolId: instanceTarget.symbolId };
      }
      const staticFq = `${current}.${member}`;
      const staticHit = ctx.symbolTable.lookup(staticFq);
      const staticTarget = pickSingleCandidate(staticHit, this.cfg.mode);
      if (staticTarget) {
        return { targetRelPath: staticTarget.relPath, targetSymbolId: staticTarget.symbolId };
      }
      // Walk one step deeper.
      current = ctx.classExtends[current];
    }
    return null;
  }
}
