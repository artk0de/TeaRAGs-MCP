import type { CallContext, CallRef } from "../../contracts/types/codegraph.js";
import type { ExternalVocabulary } from "../../contracts/types/language.js";

/**
 * Language-neutral external-call classifier (bd tea-rags-mcp-cai0). For an
 * UNRESOLVED call, decides whether it targets an external library / framework
 * runtime (→ excluded from the resolveSuccessRate denominator as
 * `callsExternalSkipped`) rather than an in-project resolver miss.
 *
 * The engine owns the one genuinely language-neutral fact: a call either has no
 * receiver (bare call → consult the bare-call vocabulary) or a qualified
 * receiver (→ consult the qualified-receiver predicate). The two
 * language-specific predicates are injected via `ExternalVocabulary`, so no
 * language's lexical conventions (what counts as a "constant" receiver, which
 * member names are framework macros) leak into this shared core. Mirrors
 * `ConeDispatchResolver` (engine = structure, locator = language primitives).
 */
export class ExternalCallClassifier {
  constructor(private readonly vocab: ExternalVocabulary) {}

  targetsExternal(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver === null) return this.vocab.isBareCallExternal(call.member, ctx);
    return (
      this.vocab.isQualifiedReceiverExternal(call.receiver, ctx, call.startLine, call.member) ||
      (this.vocab.isQualifiedMemberExternal?.(call.member) ?? false)
    );
  }

  /**
   * bd tea-rags-mcp-83cl7 — CORE-HOMONYM classification for an UNRESOLVED call
   * the external arm did NOT claim. The real callee is the language runtime
   * (`row.cells.each` → Enumerable#each), but some project class happens to
   * define the same short name, so `lookupByShortName` is non-empty and the call
   * is recorded as a recall hole it can never be. On taxdome that phantom was
   * 4391 of 20964 "misses with an in-project def".
   *
   * The engine owns the language-neutral composition — all three conditions must
   * hold, and precision runs in REVERSE (over-classification hides a real miss):
   *
   *   (a) the call has an EXPLICIT receiver. A bare call is `self`, whose type is
   *       the enclosing class — that is a typed receiver, never ambiguous.
   *   (b) the member is in the language's CORE vocabulary.
   *   (c) the receiver is UNTYPED. A typed receiver whose class genuinely defines
   *       the member is a REAL miss and stays in the denominator.
   *
   * The fourth condition — "the call actually failed resolution" — is the
   * CALLER's contract, identical to {@link targetsExternal}: the provider
   * consults this only for calls the chain could not pin, so a resolved call is
   * never reclassified.
   */
  targetsCoreAmbiguousMember(call: CallRef, ctx: CallContext): boolean {
    if (call.receiver === null) return false;
    if (!(this.vocab.isCoreAmbiguousMember?.(call.member) ?? false)) return false;
    return !(this.vocab.isReceiverTyped?.(call.receiver, ctx, call.startLine) ?? true);
  }
}
