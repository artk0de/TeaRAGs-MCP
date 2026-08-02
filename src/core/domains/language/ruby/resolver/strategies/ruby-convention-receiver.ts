import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { conventionReceiverType, typeOfReceiver } from "../type-propagation.js";
import { resolveTypeInstanceMethod, type ResolverConfig } from "./shared.js";

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
    const { receiver } = call;
    if (receiver === null) return CONTINUE;
    if (typeOfReceiver(receiver, call.startLine, ctx) !== undefined) return CONTINUE;
    const type = conventionReceiverType(receiver, ctx);
    // The convention only ever yields the `instance` form; the narrowing keeps
    // that a compile-time fact rather than a comment.
    if (type?.form !== "instance") return CONTINUE;
    const target = resolveTypeInstanceMethod(type.name, call.member, ctx, this.cfg.mode);
    // Two distinct declines: the MRO offered nothing at all, and the MRO offered
    // only the file-only degradation. Gate 3 refuses both.
    if (target === null) return CONTINUE;
    if (target.targetSymbolId === null) return CONTINUE;
    return resolved(target);
  }
}
