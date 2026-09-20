/**
 * Swift implementation of the `CallResolver` contract — the tier-2 half of the
 * Swift vertical, landing the language at the `moderate` codegraph tier beside
 * Rust and Java.
 *
 * `resolve` runs an ordered chain of single-purpose `SymbolResolutionStrategy`
 * passes (see `./strategies/`) through the shared `resolveViaChain` engine. The
 * array order IS the precedence, and the four-state outcome
 * (resolved / deferred / drop / continue) is what makes the guard drops
 * explicit rather than emergent.
 *
 * The pass order (each `name` in parens), and why each one sits where it does:
 *
 *   1. localBinding         — a receiver the walker TYPED. First because a
 *                             local declaration shadows a stored property of
 *                             the same name; Swift's scoping, not a heuristic.
 *   2. selfMember           — `self.X()` / `Self.X()` in the caller's own file.
 *                             A file-local declaration outranks anything the
 *                             project-wide passes could offer.
 *   3. storedPropertyType   — `self.field.X()` AND the implicit-self
 *                             `field.X()`, through the property's declared
 *                             type. After 1 so a local wins; after 2 so an
 *                             explicit `self.X()` is never read as a property.
 *   4. enclosingBareCall    — bare `X()` → enclosing type, same file. Beats the
 *                             terminal pass so a common name cannot misroute a
 *                             call that never left its type.
 *   5. extensionScopeMember — `self.X()` / bare `X()` → enclosing type, ANY
 *                             file. The pass Swift needs and the others do not:
 *                             a type is routinely split across extensions in
 *                             several files, so both same-file passes miss by
 *                             construction on a conformance extension.
 *   6. globalShortName      — terminal, BARE CALLS ONLY.
 *
 * ## There is deliberately no import-receiver pass
 *
 * Java's chain pivots on `importReceiver`: `import com.foo.Bar` names a TYPE,
 * so a receiver either matches an import or is dropped. Swift imports name a
 * MODULE and nothing else — `import Foundation` says which module is visible,
 * never which symbol a receiver is — so the equivalent pass would have no
 * evidence to consult and would exist only to manufacture edges. Saying so here
 * is better than a strategy that fabricates them.
 *
 * ## The precision ceiling is structurally lower than Java's, and that is fine
 *
 * The consequence of the paragraph above is that Swift resolves a
 * receiver-bearing call only where the WALKER proved a type: an annotation, a
 * CapWords initializer, a stored property, or `self`. Everything else — an
 * un-annotated `let` inferred from a function's return type, a closure
 * parameter typed by context, a protocol-typed value's dynamic dispatch,
 * `super.X()` whose supertype this vertical does not track, a chained
 * `a.b.c()` — emits NO edge. Recall is therefore capped below Java's, where the
 * import table answers a large share of receivers outright.
 *
 * Raising it is a typing problem, not a chain problem: wiring Swift into the
 * kernel's `receiver-type-propagation` fold and recording protocol / superclass
 * conformances for an MRO. Both are increments on top of this, not gaps in it.
 *
 * ## Two known limitations the tests PIN rather than work around
 *
 * 1. **A type re-opened by an extension is two symbols.** `extension Invoice`
 *    is a second `class_declaration` carrying the same name, so `collectSymbols`
 *    composes `Invoice` and `Invoice~2`, `lastSegment` strips the `~N`, and both
 *    answer the short name — so a construction expression `Invoice()` drops on
 *    the cardinality gate. Collapsing them here is not available: nothing in
 *    `SymbolDefinition` distinguishes a re-opened type from a genuine method
 *    overload, where collapsing to the first would be a wrong guess. It needs a
 *    walker channel marking container symbols. Same-file conformance extensions
 *    are idiomatic Swift, so this costs real construction edges.
 * 2. **A nested type's receiver is its SHORT name.** `Account.opening(name)`
 *    inside `Ledger` names a type whose symbol composes as
 *    `Ledger.Account.opening`, and no pass re-qualifies a bare type name
 *    against the enclosing scope.
 */

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { resolveViaChain } from "../../resolver-chain.js";
import {
  SwiftEnclosingBareCallSymbolResolutionStrategy,
  SwiftExtensionScopeMemberSymbolResolutionStrategy,
  SwiftGlobalShortNameSymbolResolutionStrategy,
  SwiftLocalBindingSymbolResolutionStrategy,
  SwiftSelfMemberSymbolResolutionStrategy,
  SwiftStoredPropertyTypeSymbolResolutionStrategy,
  type SwiftResolverConfig,
} from "./strategies/index.js";
import { lookupSwiftSymbolsByShortName } from "./swift-symbol-lookup.js";

export class SwiftCallResolver implements CallResolver {
  readonly language = "swift";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    const cfg: SwiftResolverConfig = { mode };
    this.strategies = [
      new SwiftLocalBindingSymbolResolutionStrategy(cfg),
      new SwiftSelfMemberSymbolResolutionStrategy(cfg),
      new SwiftStoredPropertyTypeSymbolResolutionStrategy(cfg),
      new SwiftEnclosingBareCallSymbolResolutionStrategy(cfg),
      new SwiftExtensionScopeMemberSymbolResolutionStrategy(cfg),
      new SwiftGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * Whether the project declares ANY Swift symbol by this member name — the
   * miss classifier's denominator question.
   *
   * Answered explicitly because this resolver's chain is Swift-filtered
   * throughout: the classifier's default falls back to the unfiltered
   * `lookupByShortName`, so a Swift call whose only namesake is a TypeScript
   * or Ruby declaration would be charged as an in-project miss the chain could
   * never have resolved (`domains/language/CLAUDE.md`, "Filtering a resolver's
   * lookups does not filter its DENOMINATOR"). Declaring it at birth costs
   * nothing; retrofitting it later would move a published rate.
   */
  hasInProjectDefinition(call: CallRef, ctx: CallContext): boolean {
    return lookupSwiftSymbolsByShortName(ctx, call.member).length > 0;
  }
}
