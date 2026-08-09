/**
 * Which receivers the dynamic short-name fan-out must NOT touch.
 *
 * `RubyDynamicDispatchResolver` is the last-resort component: it turns a call
 * whose receiver carries no static type into N discounted `dynamic` edges. That
 * is only correct for receivers nothing better can answer, so the component
 * opens with a run of gates, and every one of them is a measured decision with a
 * bead behind it. {@link rubyDynamicFanoutSuppressed} is that run, extracted
 * whole (bd tea-rags-mcp-uetqq) so the fan-out itself reads as the four lines it
 * actually is.
 *
 * Two reasons a gate fires, interleaved in the order the component evaluates
 * them — and the ORDER IS THE BEHAVIOUR, so it is preserved exactly:
 *
 *  - **the exact chain OWNS the receiver.** A precise strategy in `resolve()`
 *    pins one target for it, and fanning out first would bury that target under
 *    every same-named def in the project. These gates are on the RESOLVED
 *    target wherever a pass can decline, so a receiver the exact path cannot
 *    answer still fans out and the resolve tally is unchanged.
 *  - **the receiver is provably EXTERNAL.** The true target is a gem / stdlib /
 *    framework base class, so a same-name in-project def is wrong-type noise.
 *    Suppressing lets the external classifier reclassify the call as
 *    `externalSkipped` rather than persisting a meaningless
 *    `cg_ambiguous_fanout` aggregate, so recall is not falsely penalised.
 */

import {
  resolveLocalBinding,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
} from "../../../../../contracts/types/codegraph.js";
import { isExternalQualifiedMember } from "../../dsl/index.js";
import { SUPER_RECEIVER_SENTINEL } from "../../walker/walker.js";
import { typeOfReceiver } from "../type-propagation.js";
import { receiverLooksLikeArRelationChain } from "./ruby-ar-relation-guard.js";
import { resolveConventionReceiverTarget } from "./ruby-convention-receiver.js";
import { ivarFieldOwnsReceiver, resolveIvarFieldTarget } from "./ruby-ivar-field.js";
import { resolveBoundCallTarget } from "./ruby-return-type-binding.js";
import { receiverChainTailIsExternal, receiverIsIndexAccess, resolveConstant } from "./shared.js";

/** Ruby constants begin uppercase; `::`-joined segments form a scope chain. */
const CONSTANT_RE = /^[A-Z][A-Za-z0-9_]*(?:::[A-Z][A-Za-z0-9_]*)*$/;

/**
 * Must the dynamic short-name fan-out stand down for this call?
 *
 * The gates run in exactly the order `RubyDynamicDispatchResolver.resolveDispatch`
 * has always run them — `||` short-circuits left to right, so the first gate that
 * fires is the same one that fired before the extraction. Reordering them would
 * be a silent behaviour change measurable only as `resolveSuccessRate` /
 * `inProjectEdgeRecall` drift on a real corpus; do not.
 */
export function rubyDynamicFanoutSuppressed(call: CallRef, ctx: CallContext, mode: AmbiguousResolveMode): boolean {
  const r = call.receiver;
  if (r === null) return true; // bare call — bare-call exact path
  return (
    exactChainOwnsReceiverShape(r, ctx) ||
    exactPassAnswersReceiver(call, ctx, mode) ||
    receiverLooksLikeArRelationChain(r) || // AR::Relation chain
    indexAccessReceiverIsSuppressed(r, ctx, call.startLine) ||
    receiverChainIsExternal(r, ctx) ||
    exactChainTypesReceiver(r, call, ctx, mode) ||
    externalQualifiedMemberOnUntypedReceiver(call)
  );
}

/**
 * Receiver SHAPES the exact chain owns outright — decided from the text and the
 * binding table alone, with no strategy consulted:
 *   - super sentinel / `self`                 → super, self/bare exact path
 *   - constant receiver (`User`, `A::B`)      → constant exact path
 *   - receiver with a local binding           → localType exact path / cone
 */
function exactChainOwnsReceiverShape(receiver: string, ctx: CallContext): boolean {
  if (receiver === SUPER_RECEIVER_SENTINEL || receiver === "self") return true;
  if (CONSTANT_RE.test(receiver)) return true; // constant / type receiver
  if (ctx.localBindings && Object.prototype.hasOwnProperty.call(ctx.localBindings, receiver)) return true; // typed local
  return false;
}

/**
 * An exact pass ANSWERS this call — gated on the resolved TARGET, not on a type
 * probe, so a receiver the pass declines still fans out.
 *
 * Receiver bound to a CALL whose return type is known (`result = Svc.call(…)`;
 * bd tea-rags-mcp-j9xpf). The walker cannot type it — that needs another
 * file's return fact — so there is no `localBindings` entry, yet the
 * `returnTypeBinding` pass in `resolve()` DOES own it and emits ONE precise
 * edge. Defer to it, exactly as the typeable-chain gate below defers to
 * `chainType`. Gated on the resolved TARGET, so a binding the exact path
 * cannot answer still fans out and recall is unchanged.
 *
 * Bare `@ivar` receiver the `ivarField` pass ANSWERS (bd tea-rags-mcp-bvalc).
 * It pins exactly one target, but the fan-out ran first and buried that
 * target under every same-named def in the project — `@firm.owner` emitted
 * `Firm#owner` AND `Person#owner`. Same gate shape and same reasoning as the
 * bound-call one above: gated on the RESOLVED target, so an ivar the exact
 * path cannot answer still fans out and the resolve tally is unchanged; only
 * the wrong-type edges beside the right one go.
 *
 * "Answers" spans every tier the pass has, which is why this reads the
 * helper and not a type probe. When the naming convention became its last
 * tier (bd r2gjj) a receiver no fact typed started resolving here, and a
 * fact-only gate could not see it: 1173 taxdome sites kept 6343 discounted
 * `dynamic` edges while the chain emitted their exact edge. Reading the
 * whole answer collapses them, 1173 of 1173 agreeing with what lands
 * (bd tea-rags-mcp-eaml5, `CODEGRAPH_C2COLLAPSE_ORACLE=1` cut 3).
 */
function exactPassAnswersReceiver(call: CallRef, ctx: CallContext, mode: AmbiguousResolveMode): boolean {
  if (resolveBoundCallTarget(call, ctx, mode) !== null) return true;
  return resolveIvarFieldTarget(call, ctx, mode) !== null;
}

/**
 * Index-access receiver (`opts[k]`, `arr[i]`): suppress dynamic fan-out by
 * default (element type is untrackable → ~10%-precision noise). EXCEPTION:
 * when the base var has a typed container binding, the element type IS known
 * and `chainType` will resolve the method precisely — suppress here to defer
 * to it rather than fanning out speculative dynamic edges. Untyped index-access
 * keeps the existing suppress behaviour (bd tea-rags-mcp-mktkk increment A;
 * Task 1.6 typed-container lift).
 *
 * Both arms suppress, so the typed-container probe changes no outcome today. It
 * is kept because it is the seam the lift is written against: a future caller
 * that wants the two apart needs the distinction stated, and deleting it would
 * take the reasoning with it.
 */
function indexAccessReceiverIsSuppressed(receiver: string, ctx: CallContext, atLine: number): boolean {
  if (!receiverIsIndexAccess(receiver)) return false;
  // Attempt to extract the base var: `arr[…]` → `arr`.
  const rtrim = receiver.trimEnd();
  const bracketIdx = rtrim.indexOf("[");
  const baseVar = bracketIdx > 0 ? rtrim.slice(0, bracketIdx) : "";
  if (baseVar && /^[a-z_]\w*$/.test(baseVar)) {
    const baseBinding = resolveLocalBinding(ctx.localBindings, baseVar, atLine);
    if (baseBinding?.typeRef?.form === "container") {
      // Typed container — chainType owns the resolution; defer to it.
      return true;
    }
  }
  // Untyped index-access — suppress as before.
  return true;
}

/**
 * The receiver CHAIN dispatches on something outside the project.
 *
 * Provably-external chain tail (`req.headers`, `type.constantize`): the element
 * is core/runtime, no in-project target. Suppress; the external classifier
 * reclassifies so recall is not falsely penalised (bd Increment B / B-suppress).
 *
 * Root-segment external gate (bd tea-rags-mcp-z9pky / DEFECT 1): a chain
 * rooted in an external constant is external regardless of its tail — the
 * general signal the narrow tail vocab above defers to. Suppress so the
 * external classifier reclassifies to externalSkipped rather than persisting
 * an ambiguous aggregate (taxdome `Capybara…action…release.perform` noise).
 */
function receiverChainIsExternal(receiver: string, ctx: CallContext): boolean {
  if (receiverChainTailIsExternal(receiver)) return true;
  return chainRootConstantIsExternal(receiver, ctx);
}

/**
 * A chain receiver ROOTED in an external constant (`Capybara.<…>.perform`,
 * `Selenium::WebDriver.<…>.foo`): the whole chain dispatches on a gem / stdlib
 * object, so a same-name in-project def of the member is wrong-type noise.
 *
 * `receiverChainTailIsExternal` only knows a NARROW set of core TAILS
 * (`.headers` / `.backtrace` / …) — its own doc defers the general case to a
 * "root-segment vocab gate". An external ROOT is that general signal. Require:
 *   - a chain (`.`) — a bare constant is the constant-exact path, returned above;
 *   - a constant root (`/^[A-Z]/`) — a lowercase root can't be told apart from a
 *     project receiver, so it stays non-external (conservative, no over-suppress);
 *   - the root resolves to NO in-project file (`resolveConstant → null`) — a
 *     gem / stdlib constant. An in-project root still fans out (unchanged).
 *
 * Suppressing here (not materialising an ambiguous fan-out) lets the external
 * classifier reclassify the drop as `externalSkipped` instead of persisting a
 * meaningless `cg_ambiguous_fanout` aggregate. bd tea-rags-mcp-z9pky (DEFECT 1).
 */
function chainRootConstantIsExternal(receiver: string, ctx: CallContext): boolean {
  if (!receiver.includes(".")) return false;
  const root = receiver.split(/[.([]/)[0]?.trim() ?? "";
  if (!/^[A-Z]/.test(root)) return false;
  return resolveConstant(root, ctx) === null;
}

/**
 * An exact strategy TYPES this receiver, by fact or by convention.
 *
 * Typeable receiver: the propagation engine threads it to a known class/
 * instance type, so the precise `chainType` strategy (in resolve()) must own it
 * — suppressing here defers to it instead of fanning out speculative dynamic
 * edges. (bd tea-rags-mcp-epydb)
 *
 * The gate is TYPEDNESS, not receiver shape. It used to also require a dot,
 * mirroring the entry guard `chainType` carried at the time; `chainType`
 * dropped that guard in bd tea-rags-mcp-e8feo once `nullaryReceiverType` and
 * `scopedReceiverType` began typing bare identifiers that `localType` (needs a
 * `localBindings` entry) and `ivarField` (needs an `@`) both decline. Leaving
 * the dot here kept 1188 taxdome sites fanning out to 3794 discounted
 * `dynamic` edges where the chain had an exact answer for 848 of them
 * (bd tea-rags-mcp-55950, `CODEGRAPH_BAREDEFER_ORACLE=1`).
 *
 * The 340 sites the chain does NOT answer lose their fan-out — every one of
 * them because the derived type resolves to no in-project file (`StandardError`,
 * `Array`, `ActionController::Parameters`, `Faraday`), so the edges being
 * removed pointed at a coincidental same-named in-project def. All 340
 * reclassify to `externalSkipped`, and `missWithInProjectDef` does not move by
 * a single call — the recall hole is untouched, only false positives go.
 *
 * CONVENTION tier of the same deferral (bd tea-rags-mcp-htffz, residual C2).
 * The gate above defers when a FACT types the receiver. `conventionReceiver`
 * (bd wob7g) derives one exact target for a class of receivers no fact
 * types — the very population that reaches this line — and the fan-out did
 * not know it, so 2704 taxdome sites kept 15554 discounted `dynamic` edges
 * while an exact edge was derivable for every one of them.
 *
 * Gated on the RESOLVED target, exactly like the `ivarField` and bound-call
 * gates above: a receiver the convention cannot type, whose derived class has
 * subtypes, or whose class declares no such member still fans out, so the
 * resolve tally is unchanged and only wrong-type edges go.
 *
 * `ivarFieldOwnsReceiver` is the one carve-out, and it is a REACHABILITY fact
 * rather than a precision one: `ivarField` terminates the chain nine slots
 * before `conventionReceiver` runs, so deferring to that pass for a receiver
 * `ivarField` DROPs would trade N discounted edges for NO edge at all. The
 * `@ivar` receivers the convention CAN answer no longer reach this line —
 * the gate above collapses them through `ivarField`'s own tier (bd eaml5) —
 * so what remains here is exactly the DROP population the carve-out is for.
 */
function exactChainTypesReceiver(
  receiver: string,
  call: CallRef,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): boolean {
  const t = typeOfReceiver(receiver, call.startLine, ctx);
  if (t && (t.form === "class" || t.form === "instance")) return true;
  return !ivarFieldOwnsReceiver(call, ctx) && resolveConventionReceiverTarget(call, ctx, mode) !== null;
}

/**
 * AR/core instance member on an untyped receiver (`agent.update`): the true
 * target is an external base class (ActiveRecord::Base, ActiveModel). Fanning
 * out to a coincidental in-project def of the same name is wrong-type noise.
 * Suppress; the external classifier (Consumer 2) reclassifies so recall is not
 * penalised (bd tea-rags-mcp-i9id8). The receiver is already untyped here — all
 * typed/constant/relation/index/external-chain receivers suppressed above.
 */
function externalQualifiedMemberOnUntypedReceiver(call: CallRef): boolean {
  return isExternalQualifiedMember(call.member);
}
