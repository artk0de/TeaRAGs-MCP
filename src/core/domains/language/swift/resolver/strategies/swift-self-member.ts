import { CONTINUE, resolved } from "../../../../../contracts/resolution.js";
import type { CallContext, CallRef } from "../../../../../contracts/types/codegraph.js";
import type { SymbolResolutionOutcome, SymbolResolutionStrategy } from "../../../../../contracts/types/language.js";
import { lookupEnclosingTypeMemberInFile, type SwiftResolverConfig } from "./shared.js";

/**
 * `self.member()` and `Self.member()` — an explicit member of the enclosing
 * type, answered from the caller's OWN file first.
 *
 * `Self` joins `self` here because in a type body `Self` IS the enclosing type:
 * `Self.make()` names the same declaration `Store.make` does, and the shared
 * lookup already tries both the instance (`#`) and the static (`.`) spelling.
 * `self.init(…)` — Swift's delegating initializer — needs no arm of its own,
 * because `init` is an ordinary member name once the walker has recorded
 * `Invoice#init`.
 *
 * On a same-file miss this CONTINUES rather than dropping. Swift types are
 * routinely split across extensions in several files, so "not in this file" is
 * an ordinary state, and the extension-scope pass further down is the one that
 * answers it.
 */
export class SwiftSelfMemberSymbolResolutionStrategy implements SymbolResolutionStrategy {
  readonly name = "selfMember";
  // Same-file lookups only — no ambiguous-mode pick needed here.
  constructor(_cfg: SwiftResolverConfig) {}

  attempt(call: CallRef, ctx: CallContext): SymbolResolutionOutcome {
    if (call.receiver !== "self" && call.receiver !== "Self") return CONTINUE;
    const sameFileHit = lookupEnclosingTypeMemberInFile(call.member, ctx);
    return sameFileHit ? resolved(sameFileHit) : CONTINUE;
  }
}
