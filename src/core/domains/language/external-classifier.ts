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
    if (call.receiver === null) return this.vocab.isBareCallExternal(call.member);
    return (
      this.vocab.isQualifiedReceiverExternal(call.receiver, ctx, call.startLine, call.member) ||
      (this.vocab.isQualifiedMemberExternal?.(call.member) ?? false)
    );
  }
}
