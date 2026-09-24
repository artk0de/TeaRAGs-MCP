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
 *   3. chainedReceiverType  — a DOTTED receiver (`a.b.X()`, `self.a.b.X()`,
 *                             `World.sharedWorld.X()`) threaded through the
 *                             kernel's receiver fold, hop by hop over
 *                             `classFieldTypes` and up the superclass chain.
 *                             Ahead of 4 because that pass DROPs a `self.<x>`
 *                             it cannot type; this one reads the same channel
 *                             for the own type and CONTINUEs when it types
 *                             nothing, so 4 keeps its guard.
 *   4. storedPropertyType   — `self.field.X()` AND the implicit-self
 *                             `field.X()`, through the property's declared
 *                             type. After 1 so a local wins; after 2 so an
 *                             explicit `self.X()` is never read as a property.
 *   5. scopedTypeReceiver   — `Nested.X()` → a type nested in the caller's own
 *                             scope, by its SHORT name. Last of the receiver
 *                             passes, so a local (1) and a property (4) both
 *                             shadow it; the passes below answer no
 *                             receiver-bearing call at all.
 *   6. enclosingBareCall    — bare `X()` → enclosing type, same file. Beats the
 *                             terminal pass so a common name cannot misroute a
 *                             call that never left its type.
 *   7. extensionScopeMember — `self.X()` / bare `X()` → enclosing type, ANY
 *                             file. The pass Swift needs and the others do not:
 *                             a type is routinely split across extensions in
 *                             several files, so both same-file passes miss by
 *                             construction on a conformance extension.
 *   8. globalShortName      — terminal, BARE CALLS ONLY.
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
 * CapWords initializer, a stored property, or `self`. `chainedReceiverType`
 * threads those facts along a dotted receiver, but it cannot manufacture the
 * ones the walker never wrote — an un-annotated `let` inferred from a
 * function's return type, a closure parameter whose callee this file does
 * not declare (a same-file callee's function-typed parameter, and the element
 * of an `[T]` receiver, DO type one — bd tea-rags-mcp-y99pg.3), any link that is a METHOD call
 * rather than a property (`a.makeThing().run()`) — and each of those still
 * emits NO edge. Recall is therefore capped below Java's, where the import
 * table answers a large share of receivers outright.
 *
 * Raising it further is a typing problem, not a chain problem. The walker's
 * declared return types now reach the fold (`structuredReturnTypes`, bd
 * tea-rags-mcp-kkwg3), so a METHOD link is typed where the callee declares its
 * return, and member lookup walks every protocol a type conforms to after
 * its superclass chain (`SWIFT_MEMBER_LOOKUP_POLICY`, bd
 * tea-rags-mcp-y99pg.4).
 *
 * ## Where a TYPE NAME still does not resolve
 *
 * Two type-name gaps were closed by bd tea-rags-mcp-sg35c — a type re-opened by
 * a same-file `extension` now counts as ONE candidate
 * (`collapseReopenedTypeDeclarations` in `./swift-symbol-lookup.ts`), and a
 * nested type's short-name receiver is re-qualified against the caller's scope
 * (`scopedTypeReceiver`). Both leaned on reading a composed symbolId as a type
 * declaration (`./swift-type-name.ts`); neither needed a contract change.
 *
 * A type re-opened across FILES needed one, and has it: `struct Invoice` in
 * `Invoice.swift` and `extension Invoice` in `Invoice+Codable.swift` compose
 * the IDENTICAL id, and nothing in a `SymbolDefinition` says which carries the
 * type's own body. The walker's run-global `typeDeclarations` channel does (bd
 * tea-rags-mcp-y99pg.1), so the lookups keep only the declaring file of a type
 * id, and a construction of a type the project only EXTENDS
 * (`JSONDecoder()`) emits no edge and leaves the denominator unless an
 * extension declares an initializer (`./swift-type-declarations.ts`).
 *
 * A TOP-LEVEL type as an explicit receiver from outside it (`Invoice.empty()`
 * written in another type) is answered by `scopedTypeReceiver`'s module-scope
 * step (bd tea-rags-mcp-y99pg.9), measured on Alamofire and Quick with no
 * edge the typechecker disputes.
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
  SwiftChainedReceiverTypeSymbolResolutionStrategy,
  SwiftEnclosingBareCallSymbolResolutionStrategy,
  SwiftExtensionScopeMemberSymbolResolutionStrategy,
  SwiftGlobalShortNameSymbolResolutionStrategy,
  SwiftLocalBindingSymbolResolutionStrategy,
  SwiftScopedTypeReceiverSymbolResolutionStrategy,
  SwiftSelfMemberSymbolResolutionStrategy,
  SwiftStoredPropertyTypeSymbolResolutionStrategy,
  SwiftSuperSymbolResolutionStrategy,
  type SwiftResolverConfig,
} from "./strategies/index.js";
import { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { lookupSwiftSymbols, lookupSwiftSymbolsByShortName } from "./swift-symbol-lookup.js";
import { isSwiftReopenedOnlyType, swiftExtensionDeclaresInit } from "./swift-type-declarations.js";
import { isSwiftTypeDeclarationId, stripSwiftOverloadSuffix } from "./swift-type-name.js";

/** Whether a definition is the type id of a type the run proves the project only re-opens. */
function isReopenedOnlyTypeId(symbolId: string, ctx: CallContext): boolean {
  return isSwiftTypeDeclarationId(symbolId) && isSwiftReopenedOnlyType(stripSwiftOverloadSuffix(symbolId), ctx);
}

export class SwiftCallResolver implements CallResolver {
  readonly language = "swift";
  private readonly strategies: SymbolResolutionStrategy[];

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    // ONE lookup for the whole chain: its field union and ancestor linearizers
    // are per-RUN state, and the passes that type a receiver must answer off
    // the same fold.
    const cfg: SwiftResolverConfig = { mode, memberTypes: new SwiftMemberTypeLookup() };
    this.strategies = [
      // Index 0, ahead of every typed pass: `super` is the one receiver whose
      // meaning the LANGUAGE fixes, so no pass that infers a type can have a
      // better answer for it, and several would produce a worse one.
      new SwiftSuperSymbolResolutionStrategy(cfg),
      new SwiftLocalBindingSymbolResolutionStrategy(cfg),
      new SwiftSelfMemberSymbolResolutionStrategy(cfg),
      // Index 3, AHEAD of `storedPropertyType` and not behind it: that pass
      // DROPs a `self.<x>` it cannot type, so anything placed after it never
      // sees the shape. Safe because this one reads the same field channel for
      // the own type, resolves through the same lookup, and CONTINUEs when the
      // fold yields nothing — see the pass docblock for the full argument.
      new SwiftChainedReceiverTypeSymbolResolutionStrategy(cfg),
      new SwiftStoredPropertyTypeSymbolResolutionStrategy(cfg),
      new SwiftScopedTypeReceiverSymbolResolutionStrategy(cfg),
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
    const defs = lookupSwiftSymbolsByShortName(ctx, call.member);
    if (defs.length === 0) return false;
    // A construction of a type the project only EXTENDS runs an SDK
    // initializer unless an extension declares one (bd tea-rags-mcp-y99pg.1).
    if (call.receiver === null && defs.every((def) => isReopenedOnlyTypeId(def.symbolId, ctx))) {
      return defs.some((def) =>
        swiftExtensionDeclaresInit(stripSwiftOverloadSuffix(def.symbolId), (id) => lookupSwiftSymbols(ctx, id)),
      );
    }
    return true;
  }
}
