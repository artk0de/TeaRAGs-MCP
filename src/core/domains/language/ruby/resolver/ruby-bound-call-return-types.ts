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

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import {
  isInsideModifierCondition,
  type CallContext,
  type CallRef,
  type CallResultBinding,
} from "../../../../contracts/types/codegraph.js";
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
 *
 * `site` places the call: given a column, a call inside the condition of a
 * modifier guarding the binding's own assignment reads the binding above it
 * instead ({@link callBindingOutsideCondition}). Omitted, the chunk-wide entry
 * answers, as before.
 *
 * A BARE binding whose assignment wrote a RECEIVER (`x = Svc.new.call(…)`,
 * `x = client.call(…)`) is not a self-dispatch at all: the walker keeps only the
 * outermost method, so the spelling looks receiver-less, but the positioned
 * write still names what `call` was sent to (bd tea-rags-mcp-0qaht.56). When
 * that receiver is typed it decides — {@link receiverCallReturnType} — and the
 * flat map, whose one `call` fact describes some unrelated class, cannot
 * override it; an untyped receiver keeps the bare reading. `receiverTypeOf` is the receiver-chain fold (`typeOfReceiver`), injected so
 * this module stays below the engine that re-exports it.
 */
export function boundCallReturnTypeVia(
  receiver: string,
  ctx: CallContext,
  receiverTypeOf: RubyCallReceiverTypeOf,
  site?: Pick<CallRef, "startLine" | "startColumn">,
): RubyTypeRef | undefined {
  const chunkWide = identifierEntry(ctx.localCallBindings, receiver);
  if (chunkWide === undefined) return undefined;
  const binding = site === undefined ? chunkWide : callBindingOutsideCondition(receiver, chunkWide, site, ctx);
  if (binding === undefined) return undefined;
  const write = binding.includes(".") ? undefined : receiverWriteOf(receiver, binding, ctx, site);
  const writtenReceiverType = write && receiverTypeOf(write.receiver, write.line, ctx);
  if (writtenReceiverType !== undefined && isNominalRubyTypeRef(writtenReceiverType)) {
    const owned = receiverCallReturnType(writtenReceiverType, binding, ctx);
    if (owned === undefined || isNominalRubyTypeRef(owned)) return owned;
  }
  const derived = rubyReceiverForm(boundCallTypeRef(binding, ctx));
  return qualifyFactTypeName(derived, boundCallFactOwner(binding, ctx), ctx);
}

/** The receiver-chain fold a bound call's written receiver is typed by. */
export type RubyCallReceiverTypeOf = (receiver: string, atLine: number, ctx: CallContext) => RubyTypeRef | undefined;

/** A positioned write whose callee was sent to a receiver, split at its last link. */
interface RubyReceiverCallWrite {
  readonly line: number;
  readonly receiver: string;
}

/**
 * The positioned write behind a BARE chunk-wide spelling, when that write named
 * a receiver (bd tea-rags-mcp-0qaht.56) — or `undefined`, and the bare reading
 * stands exactly as before.
 *
 * It is the write the chunk-wide entry KEPT: the latest positioned write,
 * spelled as the entry — the same identification {@link callBindingOutsideCondition}
 * uses. A call inside that write's own modifier condition reads the write ABOVE
 * it; that placement is the condition reader's, so there this answers nothing.
 * A chain rooted at `self` or a literal is never positioned, so a self-dispatch
 * never reaches the receiver path.
 */
function receiverWriteOf(
  receiver: string,
  spelling: string,
  ctx: CallContext,
  site: Pick<CallRef, "startLine" | "startColumn"> | undefined,
): RubyReceiverCallWrite | undefined {
  const entries = identifierEntry(ctx.callResultBindings, receiver);
  if (entries === undefined) return undefined;
  let kept: CallResultBinding | undefined;
  for (const entry of entries) if (kept === undefined || entry.line >= kept.line) kept = entry;
  if (kept === undefined || localCallBindingSpelling(kept.callee) !== spelling) return undefined;
  if (
    site?.startColumn !== undefined &&
    isInsideModifierCondition(kept.conditionSpan, site.startLine, site.startColumn)
  ) {
    return undefined;
  }
  const separator = kept.callee.lastIndexOf(".");
  return separator > 0 ? { line: kept.line, receiver: kept.callee.slice(0, separator) } : undefined;
}

/**
 * What `<receiver>.<member>` returns, read off the receiver's OWN type
 * (bd tea-rags-mcp-0qaht.56): {@link returnTypeOf} — its class's declared fact,
 * the MRO, then the flat map only where the member has at most one definition —
 * and nothing else. The bare-name flat fact, which describes whichever class
 * annotated a namesake, never overrides a receiver whose class is known.
 *
 * Only a NOMINAL receiver comes here, and only a nominal answer — or none —
 * leaves. Everything else keeps the bare reading exactly as before, because
 * there the flat map is still the only knowledge the single-target consumer can
 * use: a receiver the fold cannot type, a relation / union receiver, and a
 * relation answer (`agents = current_user.agents` is `container(Agent)`, which
 * `returnTypeBinding` cannot pin, while the flat `Agent` is what huginn's
 * `agents.build_clone` edges have always read).
 *
 * The fact was written in the receiver's class, so the receiver is the scope an
 * unqualified answer is qualified from.
 */
function receiverCallReturnType(
  receiverType: RubyTypeRef & { name: string },
  member: string,
  ctx: CallContext,
): RubyTypeRef | undefined {
  return qualifyFactTypeName(rubyReceiverForm(returnTypeOf(receiverType, member, ctx)), receiverType.name, ctx);
}

/** A class or instance ref — the one shape that names a single constant. */
function isNominalRubyTypeRef(ref: RubyTypeRef): ref is RubyTypeRef & { name: string } {
  return ref.form === "class" || ref.form === "instance";
}

/**
 * The call binding a call site sees when it sits inside the CONDITION of a
 * modifier guarding the assignment that binding came from (bd
 * tea-rags-mcp-0qaht.55): `record = record.status unless record.visible?`
 * evaluates `record.visible?` BEFORE it rebinds, so there the name holds what
 * it held above the statement.
 *
 * The chunk-wide `localCallBindings` entry carries no position, so the
 * statement is read off the positioned `callResultBindings` the walker records
 * for the same assignments: the one whose `conditionSpan` holds the call. It
 * speaks only when it IS the write the entry kept — the latest positioned
 * write, spelled exactly as the entry — and then the call reads the latest
 * positioned write above it in that same spelling, or nothing when there is
 * none. Anything else — no column, no span holding the call, a later write the
 * entry kept instead — leaves the chunk-wide entry in force, exactly as before.
 */
function callBindingOutsideCondition(
  receiver: string,
  chunkWide: string,
  site: Pick<CallRef, "startLine" | "startColumn">,
  ctx: CallContext,
): string | undefined {
  const entries = identifierEntry(ctx.callResultBindings, receiver);
  if (entries === undefined || site.startColumn === undefined) return chunkWide;
  let kept: CallResultBinding | undefined;
  for (const entry of entries) if (kept === undefined || entry.line >= kept.line) kept = entry;
  if (kept === undefined || !isInsideModifierCondition(kept.conditionSpan, site.startLine, site.startColumn)) {
    return chunkWide;
  }
  if (localCallBindingSpelling(kept.callee) !== chunkWide) return chunkWide;
  let above: CallResultBinding | undefined;
  for (const entry of entries) {
    if (entry.line >= kept.line) continue;
    if (above === undefined || entry.line >= above.line) above = entry;
  }
  return above === undefined ? undefined : localCallBindingSpelling(above.callee);
}

/** A constant spelled as `localCallBindings` records a scope-qualified receiver. */
const LOCAL_CALL_BINDING_CONSTANT = /^[A-Z]\w*(?:::[A-Z]\w*)*$/;

/**
 * A positioned callee (`callResultBindings`) in the spelling `localCallBindings`
 * records for the same assignment: `Const.method` when the method is called on
 * a constant directly, the bare outermost method otherwise.
 */
function localCallBindingSpelling(callee: string): string {
  const links = callee.split(".");
  const method = links[links.length - 1] ?? callee;
  return links.length === 2 && LOCAL_CALL_BINDING_CONSTANT.test(links[0] ?? "") ? callee : method;
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
export function isProjectDeclaredConstant(name: string, ctx: CallContext): boolean {
  return identifierEntry(ctx.classAncestors, name) !== undefined || ctx.symbolTable.lookup(name).length > 0;
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
    const flat = identifierEntry(ctx.functionReturnTypes, binding);
    return flat ? { form: "instance", name: flat } : undefined;
  }
  return returnTypeOf({ form: "class", name: binding.slice(0, separator) }, binding.slice(separator + 1), ctx);
}
