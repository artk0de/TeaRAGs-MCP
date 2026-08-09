/**
 * The `localCallBindings` channel: the type a receiver carries because it was
 * assigned the RESULT OF A CALL (`result = Svc.call(…)`), plus the constant
 * lookup that makes an unqualified return-fact type name resolvable.
 *
 * The walker cannot type such a receiver — that needs another file's return
 * fact — so it records only what was called. {@link boundCallReturnType} turns
 * that record into a type through the same channels every other reader uses,
 * and {@link qualifyFactTypeName} then reads the resulting constant name the way
 * Ruby would, from the scope the annotation was WRITTEN in
 * (bd tea-rags-mcp-7fn5f).
 *
 * Split out of `type-propagation.ts` (bd tea-rags-mcp-uetqq); both gates on the
 * qualification and the two binding forms are unchanged.
 */

import type { CallContext } from "../../../../contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../contracts/types/language.js";
import { rubyReceiverForm } from "../type-ref.js";
import { returnTypeOf } from "./ruby-member-return-types.js";
import { selfMemberReturnType } from "./ruby-return-facts.js";

/**
 * The type a receiver BOUND TO A METHOD CALL carries — `result = Svc.call(…)`
 * leaves `result` with no `localBindings` entry (the walker cannot know another
 * file's return type), only a `localCallBindings` one naming what was called.
 * This is the ONE authority for that channel (bd tea-rags-mcp-j9xpf), read by
 * both the `returnTypeBinding` pass and the dynamic-dispatch component that
 * defers to it, so the two can never disagree about which receivers the exact
 * path owns.
 *
 * Two binding forms, mirroring what the walker records:
 *  - SCOPE-QUALIFIED (`"Billing::Create.call"`, recorded when the RHS receiver
 *    was a constant) — the receiver's type is known, so `returnTypeOf`
 *    answers over the CLASS object and every scoped channel applies (structured
 *    fact at the entry coordinate, ancestor MRO, then the flat map);
 *  - BARE (`"fetch"`) — no receiver was written, but the call is not
 *    context-free: it dispatches on `self`, so `selfMemberReturnType` asks
 *    the CALLER's own class and its ancestors first (bd tea-rags-mcp-rwv3o).
 *    Only when no owner-qualified fact sits on that MRO does the flat,
 *    project-wide `functionReturnTypes` map answer, exactly as before — the
 *    h4hxh close measured that silencing the flat map here costs 758 honest
 *    edges, so nothing is taken away, only overridden where a fact that
 *    demonstrably describes THIS method exists.
 *
 * The answer passes through {@link rubyReceiverForm} for the same reason
 * `typeOfReceiver`'s does (bd tea-rags-mcp-27q0z): this is a RECEIVER
 * type, and `returnTypeBinding` — its only consumer — pins a SINGLE target and
 * gives up on anything that is not class/instance form. A `[RuleHit, nil]`
 * return left as a raw union would silently cost the exact edge the same
 * annotation used to produce as a bare `[RuleHit]`.
 */
export function boundCallReturnType(receiver: string, ctx: CallContext): RubyTypeRef | undefined {
  const binding = ctx.localCallBindings?.[receiver];
  if (binding === undefined) return undefined;
  const derived = rubyReceiverForm(boundCallTypeRef(binding, ctx));
  return qualifyFactTypeName(derived, boundCallFactOwner(binding, ctx), ctx);
}

/**
 * The scope a bound-call return fact was WRITTEN in. A scope-qualified binding
 * names it outright (`Billing::Create.call` → `Billing::Create`); a bare binding
 * dispatches on `self`, so the caller's own scope owns the fact.
 */
function boundCallFactOwner(binding: string, ctx: CallContext): string {
  const separator = binding.lastIndexOf(".");
  return separator > 0 ? binding.slice(0, separator) : ctx.callerScope.join("::");
}

/** Does the RUN declare this constant? The question `resolveConstant` asks first. */
function isProjectDeclaredConstant(name: string, ctx: CallContext): boolean {
  return ctx.classAncestors?.[name] !== undefined || ctx.symbolTable.lookup(name).length > 0;
}

/**
 * Ruby's own constant lookup for an UNQUALIFIED type name, run from the scope
 * the fact was written in: `<owner>::<name>` first, then each outer nesting
 * prefix. Only candidates the project DECLARES survive.
 *
 * The top level is deliberately absent: this runs only after the literal name —
 * which IS the top-level candidate — was shown to name nothing.
 */
function ownerScopedConstantCandidates(name: string, owner: string, ctx: CallContext): string[] {
  if (name.includes("::") || owner.length === 0) return [];
  const segments = owner.split("::");
  const candidates: string[] = [];
  for (let i = segments.length; i >= 1; i--) {
    const candidate = `${segments.slice(0, i).join("::")}::${name}`;
    if (isProjectDeclaredConstant(candidate, ctx)) candidates.push(candidate);
  }
  return candidates;
}

/**
 * Qualify an UNQUALIFIED return-fact type name against the scope the fact was
 * written in (bd tea-rags-mcp-7fn5f).
 *
 * `@return [Payment]` inside `GettingPaid::RefundHelper` names
 * `GettingPaid::Payment` in Ruby — the constant is resolved from the WRITING
 * scope, not from the top level. Every type source stores the annotation's text
 * verbatim, so the engine derives a receiver type naming a class the run
 * declares nowhere, and the call dies at `receiverSetDrop`.
 *
 * Two gates make this additive rather than a guess:
 *  - it runs ONLY when the literal name names nothing the project declares. A
 *    fact whose text IS a declared class keeps its literal reading, so no call
 *    that resolves today can change target;
 *  - EXACTLY ONE nesting prefix may survive. Two declared candidates is a
 *    question the annotation genuinely does not answer, and a wrong receiver
 *    type poisons every downstream hop — the literal (dead) reading stays.
 *
 * Measured on taxdome over the 296 recall-hole misses this channel types and
 * `typeOfReceiver` does not: 50 qualify uniquely, and re-asking the production
 * terminal with the qualified name yields 49 method-level edges and 1 file-only
 * edge. The other 246 name nothing under any prefix — a genuine floor.
 *
 * Nominal refs only: a container / union / nil ref names no single constant to
 * look up and passes through untouched.
 */
function qualifyFactTypeName(ref: RubyTypeRef | undefined, owner: string, ctx: CallContext): RubyTypeRef | undefined {
  if (ref === undefined || (ref.form !== "class" && ref.form !== "instance")) return ref;
  if (isProjectDeclaredConstant(ref.name, ctx)) return ref;
  const candidates = ownerScopedConstantCandidates(ref.name, owner, ctx);
  return candidates.length === 1 ? { form: ref.form, name: candidates[0] } : ref;
}

/** {@link boundCallReturnType}'s lookup, before the receiver-form collapse. */
function boundCallTypeRef(binding: string, ctx: CallContext): RubyTypeRef | undefined {
  const separator = binding.lastIndexOf(".");
  if (separator <= 0) {
    const owned = selfMemberReturnType(binding, ctx);
    if (owned !== undefined) return owned;
    const flat = ctx.functionReturnTypes?.[binding];
    return flat ? { form: "instance", name: flat } : undefined;
  }
  return returnTypeOf({ form: "class", name: binding.slice(0, separator) }, binding.slice(separator + 1), ctx);
}
