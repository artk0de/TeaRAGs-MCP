import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupSwiftTypeMember, swiftEnclosingTypeIds, type SwiftResolverConfig } from "./shared.js";

/**
 * The enclosing type's member declared in ANOTHER file — the pass Swift needs
 * and the other languages do not.
 *
 * A Swift type is routinely spread across several files: the stored properties
 * and designated initializers in `Invoice.swift`, a protocol conformance in
 * `Invoice+Codable.swift`, view helpers in `Invoice+UI.swift`. Every one of
 * those extension bodies attributes to `Invoice` (the extension IS a
 * `class_declaration` carrying the extended type's name), so `callerScope`
 * names the type correctly while the SAME-FILE lookups two passes earlier miss
 * by construction. Without this pass, `self.format()` from a conformance
 * extension is silently unresolved across most of a real Swift corpus.
 *
 * It sits AFTER both same-file passes so a file-local declaration always wins,
 * and it answers `self` / `Self` receivers and bare calls alike — the two
 * spellings of "a member of the type I am inside". `lookupSwiftTypeMember`
 * applies the ambiguous-resolve mode, so two files declaring the same
 * `Invoice#format` produce no edge rather than a coin flip.
 *
 * On a miss, continue: a bare call may still be a free function, which the
 * terminal pass answers.
 */
export class SwiftExtensionScopeMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "extensionScopeMember";
  constructor(private readonly cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    const selfScoped = call.receiver === null || call.receiver === "self" || call.receiver === "Self";
    if (!selfScoped) return CONTINUE;
    // `self` / `Self` is the innermost type alone; a bare name walks outward,
    // as Swift's unqualified lookup does (`lookupLexicalMemberInFile`).
    const enclosingTypes = swiftEnclosingTypeIds(ctx);
    const searched = call.receiver === null ? enclosingTypes : enclosingTypes.slice(0, 1);
    for (const typeId of searched) {
      const hit = lookupSwiftTypeMember(typeId, call.member, ctx, this.cfg.mode);
      if (hit) return resolved(hit);
    }
    return CONTINUE;
  }
}
