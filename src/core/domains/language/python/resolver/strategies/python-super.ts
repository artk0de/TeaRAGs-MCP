import { CONTINUE, DROP, resolved } from "../../../../../contracts/resolution.js";
import {
  pickSingleCandidate,
  type CallContext,
  type CallRef,
  type SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import type { PythonAncestorLinearizerCache } from "../python-ancestor-policy.js";
import {
  lookupPythonSymbolsByShortName,
  pythonEnclosingClass,
  resolvePythonInheritedMember,
  type ResolverConfig,
} from "./shared.js";

/** The walker's separator for a base spelled as star-import ALTERNATIVES; see `python-ancestor-policy.ts`. */
const BASE_ALTERNATIVE_SEPARATOR = "|";

/**
 * The class NAME a base spelling carries: `a.b::Base` → `Base`, `db.Model` →
 * `Model`, `Base` → `Base`. Module texts and attribute paths both end in it.
 */
function baseClassName(spelling: string): string {
  const at = spelling.indexOf("::");
  const named = at === -1 ? spelling : spelling.slice(at + 2);
  return named.split(".").pop() ?? named;
}

/**
 * Is the base `ctx.classExtends` gives for this SHORT NAME a base some OTHER
 * class of that name has (bd tea-rags-mcp-w205u, E4.4c)?
 *
 * `classExtends` is run-global and keyed by the class short name, so polar's
 * eight `class *DoesNotExist` declarations share three entries and the last file
 * walked wins. `classAncestors` does not have the defect — it is keyed by the
 * FILE-QUALIFIED class key — so where the caller's own key records bases, they
 * are the authority on which hierarchy the legacy walk may start from.
 *
 * Three polar rows: `CheckoutDoesNotExist(CheckoutError)` walked
 * `checkout/tasks.py`'s namesake up to `PolarTaskError#__init__`, a class not on
 * the caller's MRO at all. Refusing the walk there hands the answer back to the
 * MRO, which recorded the right base in the first place.
 *
 * Deliberately narrow, on three axes. It fires only where the short name is
 * declared in MORE THAN ONE FILE, which is the only way the map can hold
 * another class's base at all — a class with one declaration keeps its walk
 * byte-identically, including the netbox star-import shape where the channels
 * name different bases because one of them could not read the star. It compares
 * the FIRST hop only, the one hop whose file-qualified key is in hand. And it
 * compares against EVERY recorded base rather than the first, because
 * `collectPythonClassExtends` skips a subscripted base while
 * `collectPythonClassAncestors` keeps it, so the two channels can disagree on
 * which base comes first while naming the same set.
 *
 * A class that records no bases, and an index that records no `classAncestors`
 * at all, carry no evidence and keep the walk they have always had.
 */
function namesOtherClass(extendsBase: string, enclosing: { key: string; name: string }, ctx: CallContext): boolean {
  const recorded = ctx.classAncestors?.[enclosing.key];
  if (recorded === undefined || recorded.length === 0) return false;
  const named = baseClassName(extendsBase);
  for (const spelling of recorded) {
    for (const alternative of spelling.split(BASE_ALTERNATIVE_SEPARATOR)) {
      if (baseClassName(alternative) === named) return false;
    }
  }
  return declaringFiles(enclosing.name, ctx) > 1;
}

/** How many files declare a class under this short name — `> 1` is what makes the run-global map a coin flip. */
function declaringFiles(shortName: string, ctx: CallContext): number {
  const files = new Set<string>();
  for (const def of lookupPythonSymbolsByShortName(ctx, shortName)) files.add(def.relPath);
  return files.size;
}

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
    const enclosing = named === undefined ? null : pythonEnclosingClass(ctx);
    if (enclosing === null) return false;
    return named === enclosing.classFq || named === enclosing.name;
  }

  /**
   * The first class AFTER the caller's own in its linearized MRO that owns
   * `member`. `null` when the caller has no enclosing class and when nothing in
   * the project defines the member, both of which the caller turns into a DROP.
   *
   * **A truncated linearization may SUPPLY an answer, never DISPLACE one.**
   * `closure !== "closed"` means a branch could not be read to its end, so
   * entries are missing from the MIDDLE of the order and "first definer" stops
   * being evidence of precedence — the membership is still sound, the ordering
   * is not. Measured on netbox: `netbox/netbox/models/__init__.py` takes every
   * base of `ChangeLoggedModel` from `from netbox.models.features import *`, so
   * the walker emits them bare, no file pins them, and the MRO of every model
   * below it stops one hop in. Seven `super()` sites that the single-parent
   * walk answered correctly then went to a truncated order, six finding nothing
   * and one reaching `TrackingModelMixin#__init__` past the
   * `ChangeLoggingMixin#__init__` the missing branch holds.
   *
   * So where the hierarchy was read to the end the MRO is authoritative, and
   * where it was not the pre-seam walk keeps the answer it already had. The
   * star-import blind spot itself belongs to the `classAncestors` channel, not
   * to this pass.
   */
  private resolveSuper(member: string, ctx: CallContext, explicit: boolean): SymbolResolutionTarget | null {
    // bd tea-rags-mcp-graiw — the enclosing class, not the whole of
    // `callerScope`: polar declares `_AuthenticatorSignature` inside
    // `def Authenticator()`, so the class FQ carries the `def`, and a call made
    // from a nested `def` carries a method the FQ must not.
    const enclosing = pythonEnclosingClass(ctx);
    if (enclosing === null) return null;
    const linearizer = this.linearizers?.for(ctx);
    // An index written by walker v2 carries no `classAncestors`. Keep the
    // pre-seam single-base walk for it — but only for the bare form, whose
    // start position that walk actually models.
    if (linearizer === undefined) return explicit ? null : this.resolveSuperViaClassExtends(member, ctx);
    const { target, closure } = resolvePythonInheritedMember(enclosing.key, member, ctx, this.cfg.mode, linearizer, {
      startAfter: true,
    });
    if (closure === "closed") return target;
    return this.resolveSuperViaClassExtends(member, ctx) ?? target;
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
    const enclosingClass = pythonEnclosingClass(ctx);
    const enclosing = enclosingClass?.name;
    if (enclosing === undefined) return null;
    let current: string | undefined = ctx.classExtends[enclosing];
    if (!current) return null;
    if (enclosingClass !== null && namesOtherClass(current, enclosingClass, ctx)) return null;
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
