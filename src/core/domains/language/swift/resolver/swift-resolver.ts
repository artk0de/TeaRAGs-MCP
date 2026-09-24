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
 *                             shadow it.
 *   6. moduleValue          — `AF.X()` → the type of a MODULE-LEVEL value
 *                             (`let AF = Session.default`), declared in any
 *                             file (bd tea-rags-mcp-y99pg.30). Last of the
 *                             receiver passes because module scope is the
 *                             outermost one; the passes below answer no
 *                             receiver-bearing call at all.
 *   7. enclosingBareCall    — bare `X()` → enclosing type, same file. Beats the
 *                             terminal pass so a common name cannot misroute a
 *                             call that never left its type.
 *   8. extensionScopeMember — `self.X()` / bare `X()` → enclosing type, ANY
 *                             file. The pass Swift needs and the others do not:
 *                             a type is routinely split across extensions in
 *                             several files, so both same-file passes miss by
 *                             construction on a conformance extension.
 *   9. globalShortName      — terminal, BARE CALLS ONLY.
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

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  resolveLocalBinding,
  type AmbiguousResolveMode,
  type CallContext,
  type CallRef,
  type CallResolver,
  type SymbolDefinition,
  type SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { SymbolResolutionStrategy } from "../../../../contracts/types/language.js";
import { propagateReceiverType, type ReceiverTypePorts } from "../../kernel/index.js";
import { resolveViaChain } from "../../resolver-chain.js";
import { swiftSdkVocabulary, type SwiftSdkVocabulary } from "../vocabulary/sdk-vocabulary.js";
import { swiftSpelledNominal } from "../vocabulary/swift-type-text.js";
import {
  SwiftChainedReceiverTypeSymbolResolutionStrategy,
  SwiftEnclosingBareCallSymbolResolutionStrategy,
  SwiftExtensionScopeMemberSymbolResolutionStrategy,
  SwiftGlobalShortNameSymbolResolutionStrategy,
  SwiftLocalBindingSymbolResolutionStrategy,
  SwiftModuleValueSymbolResolutionStrategy,
  SwiftScopedTypeReceiverSymbolResolutionStrategy,
  SwiftSelfMemberSymbolResolutionStrategy,
  SwiftStoredPropertyTypeSymbolResolutionStrategy,
  SwiftSuperSymbolResolutionStrategy,
  type SwiftResolverConfig,
} from "./strategies/index.js";
import { swiftSelfTypeName } from "./swift-enclosing-scope.js";
import { SwiftMemberTypeLookup } from "./swift-member-type-lookup.js";
import { createSwiftReceiverTypePorts } from "./swift-receiver-type-ports.js";
import {
  lookupSwiftBareNameDefinitions,
  lookupSwiftSymbolsByShortName,
  swiftMemberCandidates,
} from "./swift-symbol-lookup.js";
import { isSwiftReopenedOnlyType, swiftDeclaringFiles, swiftExtensionDeclaresInit } from "./swift-type-declarations.js";
import { isSwiftTypeDeclarationId, isSwiftTypeName, stripSwiftOverloadSuffix } from "./swift-type-name.js";

/**
 * Receiver types on which Swift looks a member up DYNAMICALLY: any `@objc`
 * method of any class is callable on an `AnyObject` / `AnyClass` value, so a
 * project method of that name may be the target whatever the type declares.
 */
const SWIFT_DYNAMIC_LOOKUP_TYPES: ReadonlySet<string> = new Set(["AnyObject", "AnyClass"]);

/** Whether a definition is the type id of a type the run proves the project only re-opens. */
function isReopenedOnlyTypeId(symbolId: string, ctx: CallContext): boolean {
  return isSwiftTypeDeclarationId(symbolId) && isSwiftReopenedOnlyType(stripSwiftOverloadSuffix(symbolId), ctx);
}

export class SwiftCallResolver implements CallResolver {
  readonly language = "swift";
  private readonly strategies: SymbolResolutionStrategy[];
  private readonly memberTypes = new SwiftMemberTypeLookup();
  /** What the SDK declares (bd tea-rags-mcp-y99pg.24): the generated substrate, shared process-wide. */
  private readonly sdk: SwiftSdkVocabulary = swiftSdkVocabulary();
  /** The chain's own receiver fold, reused by the denominator question. */
  private readonly ports: ReceiverTypePorts = createSwiftReceiverTypePorts(this.memberTypes);

  constructor(mode: AmbiguousResolveMode = DEFAULT_AMBIGUOUS_RESOLVE_MODE) {
    // ONE lookup for the whole chain: its field union and ancestor linearizers
    // are per-RUN state, and the passes that type a receiver must answer off
    // the same fold.
    const cfg: SwiftResolverConfig = { mode, memberTypes: this.memberTypes };
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
      new SwiftModuleValueSymbolResolutionStrategy(cfg),
      new SwiftEnclosingBareCallSymbolResolutionStrategy(cfg),
      new SwiftExtensionScopeMemberSymbolResolutionStrategy(cfg),
      new SwiftGlobalShortNameSymbolResolutionStrategy(cfg),
    ];
  }

  resolve(call: CallRef, ctx: CallContext): SymbolResolutionTarget | null {
    return resolveViaChain(this.strategies, call, ctx);
  }

  /**
   * Whether the project declares a Swift symbol this call could land on — the
   * miss classifier's denominator question. A member name no Swift file
   * declares answers false; so does a typed receiver whose hierarchy reaches
   * none of the declarations that do (bd tea-rags-mcp-y99pg.11, see
   * `receiverMayReach`).
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
    if (call.receiver === null) return this.bareNameMayReach(call, ctx);
    return this.receiverMayReach(call, ctx, defs);
  }

  /**
   * Whether a BARE call can reach a project declaration. A nested type whose
   * container does not enclose the caller is invisible to the unqualified
   * name (bd tea-rags-mcp-y99pg.15) — `Result(value:error:)` outside
   * `PathMonitor` names the standard library's `Result`.
   */
  private bareNameMayReach(call: CallRef, ctx: CallContext): boolean {
    const defs = lookupSwiftBareNameDefinitions(ctx, call.member);
    if (defs.length === 0) return false;
    // Swift's `self` is implicit: inside a type whose hierarchy the SDK
    // declares the member on and the project does not, the bare name IS that
    // member, shadowing every project namesake on another type or at module
    // scope — `map(\.result)` inside a `Publisher` (bd tea-rags-mcp-y99pg.29).
    const enclosing = swiftSelfTypeName(ctx);
    if (
      enclosing !== undefined &&
      ctx.typeDeclarations !== undefined &&
      !this.memberTypes.memberReach(enclosing, call.member, ctx).declared &&
      this.memberTypes.sdkDeclaresMember(enclosing, call.member, ctx)
    ) {
      return false;
    }
    // A construction of a type the project only EXTENDS runs an SDK
    // initializer unless an extension declares one the call's argument
    // labels fit (bd tea-rags-mcp-y99pg.1, .11): `Result { try … }` runs
    // the standard library's `init(catching:)` beside a project
    // `init(value:error:)`.
    if (defs.every((def) => isReopenedOnlyTypeId(def.symbolId, ctx))) {
      return defs.some((def) =>
        swiftExtensionDeclaresInit(stripSwiftOverloadSuffix(def.symbolId), (id) =>
          swiftMemberCandidates(ctx, id, call),
        ),
      );
    }
    return true;
  }

  /**
   * Whether a RECEIVER call can reach one of the project's `defs` of its
   * member (bd tea-rags-mcp-y99pg.11).
   *
   * Swift is statically typed: a call on a value of type `T` names a member
   * declared on `T`, on a type `T` inherits from or conforms to, or in an
   * extension of one of those. Once the receiver's type is known, a project
   * member of the same name on any OTHER type is a namesake — `task.resume()`
   * on a `URLSessionTask` runs Foundation's `resume`, whatever `Request`
   * declares — and the site can never become an in-project edge. The TS
   * resolver answers the same question with its checker; this one answers it
   * with the receiver fold the chain already runs, and declines (keeps the
   * site in the denominator) wherever it cannot prove the world is closed:
   *
   *   - a receiver it cannot type;
   *   - an index with no `typeDeclarations` channel, where "declared" and
   *     "extended" cannot be told apart;
   *   - a def on a type the project only extends that the SDK substrate does
   *     not declare, or reached from a receiver type whose supertypes neither
   *     the project nor the substrate publishes (bd tea-rags-mcp-y99pg.24).
   */
  private receiverMayReach(call: CallRef, ctx: CallContext, defs: readonly SymbolDefinition[]): boolean {
    if (ctx.typeDeclarations === undefined) return true;
    const typeName = this.receiverTypeName(call, ctx);
    if (typeName === undefined) return true;
    const reach = this.memberTypes.memberReach(typeName, call.member, ctx);
    // Declared on the hierarchy — unless no project overload takes the call's
    // labels and the SDK declares the member there too (bd tea-rags-mcp-y99pg.25).
    if (reach.declared) return !this.memberTypes.runsSdkOverload(typeName, call, ctx);
    // A project type has initializers it never spells (`super.init()` on a
    // class that declares none inherits its superclass's): the type itself is
    // the in-project target.
    if (call.member === "init" && (swiftDeclaringFiles(typeName, ctx)?.size ?? 0) > 0) return true;
    for (const def of defs) {
      if (def.scope.length === 0) continue;
      const owner = def.scope.join(".");
      if (reach.types.has(owner)) return true;
      const declaring = swiftDeclaringFiles(owner, ctx);
      // The run says nothing about the owner: nothing is proven.
      if (declaring === undefined) return true;
      // A type the project declares, outside the receiver's hierarchy: a namesake.
      if (declaring.size > 0) continue;
      // A re-opened SDK type outside the receiver's hierarchy — which the
      // lookup read through the SDK substrate — is a namesake too (bd
      // tea-rags-mcp-y99pg.24). Neither a re-opened name the substrate does
      // not know nor a receiver type whose supertypes nobody publishes proves
      // anything.
      if (!this.sdk.hasType(swiftSpelledNominal(owner)) || !this.hierarchyKnown(typeName, ctx)) return true;
    }
    return false;
  }

  /** Whether the project or the SDK substrate declares `typeName`, so its supertypes are on record. */
  private hierarchyKnown(typeName: string, ctx: CallContext): boolean {
    return (swiftDeclaringFiles(typeName, ctx)?.size ?? 0) > 0 || this.sdk.hasType(typeName);
  }

  /**
   * The nominal a call's receiver denotes: the superclass for `super`, else
   * the chain's own fold — which types a module-level value
   * (Alamofire's `let AF = Session.default`) where the walker published one
   * (bd tea-rags-mcp-y99pg.30). An UpperCamelCase receiver nothing in the
   * project declares is usually an SDK type, but it may as well be a global
   * value an older index has no channel for, so it types one only when the
   * generated SDK substrate declares the name (bd tea-rags-mcp-y99pg.24). A receiver typed `AnyObject` / `AnyClass`
   * types nothing: see {@link SWIFT_DYNAMIC_LOOKUP_TYPES}.
   */
  private receiverTypeName(call: CallRef, ctx: CallContext): string | undefined {
    const { receiver } = call;
    if (receiver === null) return undefined;
    if (receiver === "super") {
      // `super` names the superclass the enclosing type's clause states first.
      const enclosing = swiftSelfTypeName(ctx);
      return enclosing === undefined ? undefined : identifierEntry(ctx.classExtends, enclosing);
    }
    const type = propagateReceiverType(receiver, call.startLine, ctx, this.ports);
    if (type !== undefined) {
      if (type.form !== "class" && type.form !== "instance") return undefined;
      // A type known only as a bound proves nothing about what the value cannot reach (bd tea-rags-mcp-y99pg.25).
      if (type.upperBound === true) return undefined;
      return SWIFT_DYNAMIC_LOOKUP_TYPES.has(type.name) ? undefined : type.name;
    }
    // An SDK type spelled as the receiver: only a type the SDK substrate
    // declares, which the project neither declares nor binds as a local.
    if (!isSwiftTypeName(receiver) || !this.sdk.hasType(receiver)) return undefined;
    if ((swiftDeclaringFiles(receiver, ctx)?.size ?? 0) > 0) return undefined;
    return resolveLocalBinding(ctx.localBindings, receiver, call.startLine) === undefined ? receiver : undefined;
  }
}
