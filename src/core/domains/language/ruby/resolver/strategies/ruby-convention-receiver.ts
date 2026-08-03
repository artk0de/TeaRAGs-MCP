import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { conventionReceiverType, typeOfReceiver } from "../type-propagation.js";
import { resolveTypeInstanceMethod, type ResolverConfig } from "./shared.js";

/**
 * The single precise target the `conventionReceiver` pass emits for `call`, or
 * `null` when it cannot answer. Same single-authority discipline as
 * {@link resolveIvarFieldTarget} and `resolveBoundCallTarget`: read by the
 * strategy below AND by `RubyDynamicDispatchResolver`, which must know whether
 * the exact path ACTUALLY answers before it decides to fan out (bd
 * tea-rags-mcp-htffz). Two separate lookups would drift, and a receiver the
 * fan-out believes untyped while the pass pins it produces N wrong-type edges
 * that bury the right one.
 *
 * The three gates are the strategy's, unchanged and documented on it. The order
 * differs by one step for cost only: the convention's own receiver-shape regex
 * rejects the overwhelming majority of receivers with no map lookup at all, so it
 * runs before the `typeOfReceiver` fact probe. Both predicates are pure, so the
 * swap cannot change an answer.
 */
export function resolveConventionReceiverTarget(
  call: CallRef,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const { receiver } = call;
  if (receiver === null) return null;
  // The convention only ever yields the `instance` form; the narrowing keeps
  // that a compile-time fact rather than a comment.
  const type = conventionReceiverType(receiver, ctx);
  if (type?.form !== "instance") return null;
  if (typeOfReceiver(receiver, call.startLine, ctx) !== undefined) return null;
  const target = resolveTypeInstanceMethod(type.name, call.member, ctx, mode);
  // Two distinct declines: the MRO offered nothing at all, and the MRO offered
  // only the file-only degradation. Gate 3 refuses both.
  if (target === null) return null;
  if (target.targetSymbolId === null) return null;
  return target;
}

/**
 * Naming-convention receiver typing (bd tea-rags-mcp-wob7g) — `payment.refund`
 * resolves to `Payment#refund` because Rails names a variable after its class.
 *
 * **Why a pass of its own, at this exact slot.** The 2026-08-02 residual
 * taxonomy of taxdome's recall hole attributed 56.8% of it to ONE guard,
 * `receiverSetDrop`, whose entire predicate is `call.receiver !== null`. The
 * hole is not a resolution-precision problem and not a definer-reachability
 * problem — it is a RECEIVER-TYPING problem: 89.7% of single-segment receivers
 * are untyped by every fact channel, so there is no type for the typed-receiver
 * passes to consume. This pass sits immediately BEFORE `receiverSetDrop`, so
 * every fact channel, the Zeitwerk constant pass and the AR-relation guard all
 * win first, and only a call already on its way to the catch-all DROP is
 * offered a naming-convention guess.
 *
 * **Three gates, each one measured on taxdome, none of them an argument.**
 *
 *  1. A real fact wins. The pass CONTINUEs whenever `typeOfReceiver` answers,
 *     so the single-segment population the fact channels DO own is handed back
 *     untouched and cannot be double-counted (bd tea-rags-mcp-e8feo / ikyqu).
 *  2. The derived class must exist AND have no subtypes — see
 *     {@link conventionReceiverType}. Guessing a polymorphic base for a
 *     variable that carries a concrete subtype is where every measured
 *     convention error came from.
 *  3. The terminal must PIN a method. `resolveTypeInstanceMethod` degrades to a
 *     file-only edge (`targetSymbolId: null`) when the class resolves but
 *     declares no such member; this pass declines that, because a file-only
 *     edge does nothing for `get_callers` and inflates file fan-in on the
 *     biggest models in the app. Accepting it would buy another +0.57pp of
 *     "recall" made of edges that point at no symbol.
 *
 * Gate 3 turns out to carry the precision case on its own. Graded against the
 * resolver's OWN fact channels — every call whose receiver a real fact types is
 * a labelled example — the convention names the wrong CLASS on 10.1% of 3712
 * samples. But of the 1429 samples where the terminal actually fires, 1057 emit
 * the same target the fact does and ZERO emit a different one: when the guess
 * is wrong, the wrong class simply does not declare the member, so no edge is
 * born. 372 wrong guesses die silently at the terminal. Edge accuracy: 100%.
 *
 * Never DROPs. A DROP here would claim the receiver's type is known-and-foreign,
 * which is exactly what a convention guess cannot establish; `receiverSetDrop`
 * remains the one pass that decides these calls are over.
 */
export class RubyConventionReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "conventionReceiver";
  constructor(private readonly cfg: ResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const target = resolveConventionReceiverTarget(call, ctx, this.cfg.mode);
    return target === null ? CONTINUE : resolved(target);
  }
}
