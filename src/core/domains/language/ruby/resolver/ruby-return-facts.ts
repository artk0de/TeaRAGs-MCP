/**
 * Where a DECLARED Ruby return fact lives, and which coordinate answers for a
 * given receiver form.
 *
 * The resolver asks "what does `<class>.<member>` declare that it returns" from
 * three places — the chain-root seed, the member-return engine, and the
 * receiver-less `self` dispatch — and every one of them reads a coordinate
 * stated here, so no reader can drift on which key answers:
 *
 *  - {@link declaredReturnTypeOn} — the fact written AT that class, honouring
 *    the `.`-vs-`#` key split a CLASS receiver is allowed to see
 *    (bd tea-rags-mcp-8ypeu);
 *  - {@link inheritedReturnType} / {@link declaredReturnType} — the same fact
 *    reached through Ruby's MRO rather than through walker storage order
 *    (bd tea-rags-mcp-mo5ur);
 *  - {@link selfMemberReturnType} — the fact a RECEIVER-LESS call finds by
 *    dispatching on `self` (bd tea-rags-mcp-rwv3o / -z5gqv / -uuux9).
 *
 * {@link flatReturnFactMayOverrideKnownReceiver} sits beside them because it
 * gates the one channel that carries NO owning class — the flat
 * `functionReturnTypes` map (bd tea-rags-mcp-h4hxh).
 *
 * Split out of `type-propagation.ts` (bd tea-rags-mcp-uetqq). Lookups are
 * unchanged; only their address moved.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { linearizeAncestors } from "./ancestor-linearization.js";

/**
 * The DECLARED return type at a `<className>.<member>` coordinate: the precise
 * structured fact, then the same fact inherited through the ancestor MRO. Facts
 * only — no vocabulary, no flat by-name fallback, no association accessors (those
 * are instance-only and stay in `returnTypeOf`).
 *
 * Extracted so the chain-root seed can ask "is this member DECLARED on the root
 * constant?" through the very channels `returnTypeOf` consults, instead of
 * growing a second lookup that could drift (bd tea-rags-mcp-6zpds).
 */
export function declaredReturnType(className: string, member: string, ctx: CallContext): RubyTypeRef | undefined {
  return declaredReturnTypeOn(className, member, ctx, true) ?? inheritedReturnType(className, member, ctx, true);
}

/**
 * The structured fact declared AT `<className>.<member>` / `<className>#<member>`.
 *
 * Facts are keyed with `#` by default — including `def self.x` `@return`s, which
 * the engine deliberately answers for class receivers too. A fact that declares
 * itself class-level (an `@!method self.x` directive) is keyed with `.`, so a
 * CLASS receiver tries that coordinate first and falls back to the shared `#`
 * one (bd tea-rags-mcp-8ypeu). Instance receivers never see the `.` key.
 */
export function declaredReturnTypeOn(
  className: string,
  member: string,
  ctx: CallContext,
  classReceiver = false,
): RubyTypeRef | undefined {
  if (classReceiver) {
    const classForm = ctx.structuredReturnTypes?.[`${className}.${member}`];
    if (classForm !== undefined) return classForm;
  }
  return ctx.structuredReturnTypes?.[`${className}#${member}`];
}

/**
 * May the FLAT, bare-name `functionReturnTypes` fact answer for `member` when
 * the receiver's own class is ALREADY KNOWN (bd tea-rags-mcp-h4hxh)?
 *
 * The map is keyed by method name alone and carries no owning class, so a single
 * `# @return [Response]` on one helper's `authorize` speaks for every `authorize`
 * in the corpus. Channels 1–3 of `returnTypeOf` have already asked the receiver's class and
 * its ancestors and come back empty, which means any answer this map gives is by
 * construction some OTHER class's annotation — measured on taxdome: of 871
 * scope-qualified binding sites where this fallback fires, 805 apply a fact whose
 * owning class is not in the receiver's MRO and NONE apply one that is.
 *
 * The fact is still worth having where the corpus cannot disagree about which
 * method it describes: at most ONE definition of the short name. Two or more and
 * it is a coin flip between unrelated classes — the map's most collided taxdome
 * keys are `initialize` at 3 097 definitions, `perform` at 2 547, `data` at 244.
 * ZERO definitions still passes: an empty index is absence of evidence, not
 * evidence of ambiguity, and the fact then describes something the symbol table
 * does not model (a gem method, a macro-synthesised accessor) exactly as before.
 *
 * Deliberately NOT applied to `boundCallReturnType`'s bare branch: there
 * the receiver has no type at all, so the flat map is not overriding better
 * knowledge — it is the only knowledge. Gating it there measured −758 edges on
 * taxdome that no oracle can individually convict, so that half stays open as
 * its own lead (owner-aware facts, not a wider gate).
 */
export function flatReturnFactMayOverrideKnownReceiver(member: string, ctx: CallContext): boolean {
  return ctx.symbolTable.lookupByShortName(member).length <= 1;
}

/**
 * The structured fact `<member>` inherits from the NEAREST ancestor declaring it.
 *
 * Same {@link linearizeAncestors} walk as {@link selfMemberReturnType}, and for
 * the same reason: raw `classAncestors` is walker storage order
 * (`[superclass, ...includes]`) one level deep, so a first-wins loop over it
 * hands the superclass's fact to a call Ruby routes through a mixin, and never
 * sees a fact on a grandparent or on a mixin's own ancestor at all. Walking the
 * linearization states Ruby's rule once and keeps the two fact channels from
 * drifting on which coordinate answers (bd tea-rags-mcp-mo5ur).
 */
export function inheritedReturnType(
  className: string,
  member: string,
  ctx: CallContext,
  classReceiver = false,
): RubyTypeRef | undefined {
  for (const ancestor of linearizeAncestors(className, ctx)) {
    const inherited = declaredReturnTypeOn(ancestor, member, ctx, classReceiver);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

/**
 * The OWNER-QUALIFIED return fact a receiver-less call to `member` finds by
 * dispatching on `self` (bd tea-rags-mcp-rwv3o) — the ONE authority for that
 * question, shared by `boundCallReturnType`'s bare branch and
 * `nullaryReceiverType`, so the two consumers cannot drift on which
 * coordinate answers.
 *
 * The point of asking here at all is that the flat `functionReturnTypes` map is
 * keyed by bare name across the whole corpus, so for a multiply-defined name it
 * describes some other class's method. A fact sitting on the caller's own MRO
 * describes the method this call actually reaches, and outranks it.
 *
 * WHICH coordinate is asked follows the CALLER's own form (bd tea-rags-mcp-z5gqv).
 * A bare call binds `self`, and `ctx.callerSymbolId` says what `self` is: inside
 * `Klass.build` it is the class object, so the `.` coordinate an
 * `@!method self.x` directive (or the service-entry fold) claims is legal and is
 * read FIRST; inside `Klass#render` it is an instance, and that coordinate must
 * stay invisible or the reader answers a call Ruby would reject. Both forms keep
 * the `#` fallback — that is where every declared fact is keyed today, which is
 * why all 439 measured class-method reads on taxdome land there and only the 7
 * instance-method ones were reading a class-level fact they had no right to.
 *
 * A class/module-BODY caller carries neither separator. It is left on the
 * instance coordinate deliberately: `self` there IS the class object, but no
 * measured read moves, and widening the reader beyond the population the switch
 * was priced over would be an unmeasured behavior change.
 *
 * ONE level, not two: the caller's class and its ancestors are asked as a single
 * {@link linearizeAncestors} walk, and the NEAREST coordinate carrying a fact
 * answers. That is Ruby's rule stated once — a definition on the class shadows
 * its ancestors because the class sits ahead of them in its own MRO, and a
 * `prepend`ed module shadows the class for the same reason.
 *
 * It used to be two levels with a disagreement guard: own class outright, then
 * ancestors that had to AGREE or the answer collapsed to silence. The guard
 * existed because the raw `classAncestors` list is walker storage order
 * (`[superclass, ...includes]`), where "first entry" is not "nearest
 * definition" — so two ancestors declaring different return types was a question
 * the flat list genuinely could not answer, and a wrong receiver type poisons
 * every downstream hop. The linearization answers it, so the silence is gone
 * (bd tea-rags-mcp-uuux9).
 *
 * `undefined` when the call site has no enclosing class (a top-level `def`, a
 * bare script statement) — there is no owner to ask, and callers fall back to
 * whatever they did before.
 */
export function selfMemberReturnType(member: string, ctx: CallContext): RubyTypeRef | undefined {
  if (ctx.callerScope.length === 0) return undefined;
  const classSelf = callerBindsClassSelf(ctx);
  for (const owner of linearizeAncestors(ctx.callerScope.join("::"), ctx)) {
    const declared = declaredReturnTypeOn(owner, member, ctx, classSelf);
    if (declared !== undefined) return declared;
  }
  return undefined;
}

/**
 * Does `self` at the CALL SITE name the class object rather than an instance?
 *
 * The caller's symbolId encodes its own form: `Klass.build` is a class method,
 * `Klass#render` an instance method, and a class/module-body chunk carries
 * neither separator (its symbolId is the bare class FQ — the same shape
 * `RubyBareCallSymbolResolutionStrategy` keys on). Absent symbolId means the
 * form is unknown, and the instance coordinate is the safe reading: it is where
 * every declared fact is keyed.
 */
function callerBindsClassSelf(ctx: CallContext): boolean {
  const symbolId = ctx.callerSymbolId;
  return symbolId !== undefined && !symbolId.includes("#") && symbolId.lastIndexOf(".") > 0;
}
