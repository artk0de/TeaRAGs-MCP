/**
 * What a PROPERTY of a Swift type denotes — the one place the declared type of
 * `<typeName>.<member>` is looked up, for every pass that needs it.
 *
 * One collaborator rather than a helper per pass, because two passes ask the
 * same question and must get the same answer: the chain fold's ports
 * (`./swift-receiver-type-ports.ts`) for every link of a dotted receiver, and
 * `storedPropertyType` for a single-hop one. Were they to read different
 * channels, the chain pass that sits one slot AHEAD of `storedPropertyType`
 * would stop being the strict superset its placement argument rests on.
 *
 * ## The caller's own file first, the run second
 *
 *   1. `ctx.classFieldTypes` — the CALLER's own file. It is the source text the
 *      call sits in rather than anything folded across the run, so reading it
 *      first is what keeps a wider search from ever moving an edge that
 *      resolves today.
 *   2. {@link SwiftTypeFieldIndex} — every other Swift file of the run, unioned
 *      per type name out of `classFieldTypesByClassKey`. Without it a chain
 *      dies at hop 2 on any real corpus (hop 1's type is declared in its own
 *      file, not the caller's), and an implicit-self property an `extension`
 *      declares elsewhere is invisible.
 *
 * ## And then the superclass chain
 *
 * Swift declares stored properties on a base class and uses them from
 * subclasses constantly — `self.eventMonitor` is declared on `Request` and
 * called from `DataRequest`. The walk reuses the driver and the policy `super`
 * already walks (`kernel/ancestor-walk.ts`, `SWIFT_ANCESTOR_POLICY`)
 * rather than re-deriving the order, so the passes can never disagree about
 * what a class's superclass is. A class with no `classExtends` entry linearizes
 * to itself alone, which is exactly the own-type read this generalises. After the superclass
 * chain the walk reaches every protocol the type conforms to
 * ({@link SWIFT_MEMBER_LOOKUP_POLICY}), since a requirement and a protocol
 * extension's default are members of every conforming type.
 *
 * Built ONCE per resolver and handed to every pass that needs it: the
 * linearizer memo and the field union are per-run state, and a second instance
 * would rebuild both for the same run. The memos are scoped through
 * {@link RunScopedMemo} rather than a bare `WeakMap`, for the reason
 * `swift-super.ts` states — `LanguageFactory.create` caches a resolver for the
 * factory's lifetime, so a memo keyed on context identity alone would serve one
 * run's hierarchy to the next (bd tea-rags-mcp-z99hp).
 */

import { identifierEntry } from "../../../../contracts/identifier-record.js";
import type {
  AmbiguousResolveMode,
  CallContext,
  CallRef,
  SymbolResolutionTarget,
} from "../../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../../contracts/types/language.js";
import {
  createAncestorLinearizer,
  findMemberInAncestorChain,
  RunScopedMemo,
  type AncestorLinearizer,
} from "../../kernel/index.js";
import { swiftSdkVocabulary, type SwiftSdkVocabulary } from "../vocabulary/sdk-vocabulary.js";
import { parseSwiftTypeText, swiftSpelledNominal, type SwiftTypeExpr } from "../vocabulary/swift-type-text.js";
import { SWIFT_MEMBER_LOOKUP_POLICY } from "./swift-ancestor-policy.js";
import { SwiftModuleValueIndex } from "./swift-module-values.js";
import { SwiftSdkMemberTypes, type SwiftNominalTypeRef, type SwiftSelfAliases } from "./swift-sdk-member-types.js";
import {
  lookupSwiftOverloads,
  lookupSwiftTypeMember,
  qualifySwiftTypeName,
  qualifySwiftTypeNameWithin,
  swiftMemberCandidates,
} from "./swift-symbol-lookup.js";
import {
  swiftFieldTypeArguments,
  swiftGenericFieldParameter,
  swiftGenericParameters,
  swiftIsOptionalProperty,
  swiftMemberClosureParameters,
  swiftMemberTypeAliases,
  swiftPropertyAttributeTypes,
  swiftWhereClauseAt,
} from "./swift-type-declarations.js";
import { SwiftTypeFieldIndex } from "./swift-type-field-index.js";

/** A method's closure signature, as its declaring type states it. */
export interface SwiftClosureSignature {
  /** The closure's parameter types; `null` for the whole list when declarations disagree. */
  readonly types: readonly (string | null)[] | null;
  /** The declaring type's generic parameters, which entries of `types` may name. */
  readonly genericParameters: readonly string[];
  /** The declaring type, from which a nominal entry is qualified. */
  readonly ownerTypeId: string;
}

/** A receiver as the SDK substrate is asked about it: the nominal, its lookup order, `Self`'s project aliases. */
interface SwiftSdkView {
  readonly receiver: SwiftNominalTypeRef;
  readonly order: readonly string[];
  readonly selfAliases: SwiftSelfAliases | undefined;
}

/** What a member lookup on one type can reach: see {@link SwiftMemberTypeLookup#memberReach}. */
export interface SwiftMemberReach {
  /** Whether a type the lookup reads declares the member at all. */
  readonly declared: boolean;
  /** The types the lookup reads, as written and as qualified. */
  readonly types: ReadonlySet<string>;
}

export class SwiftMemberTypeLookup {
  private readonly linearizers = new RunScopedMemo<CallContext, AncestorLinearizer<CallContext>>();
  private readonly fields = new SwiftTypeFieldIndex();
  /** Module-level values, read through the same per-run memos (bd tea-rags-mcp-y99pg.30). */
  readonly moduleValues = new SwiftModuleValueIndex();
  private readonly sdkMembers: SwiftSdkMemberTypes;

  /**
   * @param sdk The SDK substrate, the second declaration source a lookup
   *   reads — after the project, and only for a member the project declares
   *   on none of the receiver's types (bd tea-rags-mcp-y99pg.25).
   */
  constructor(private readonly sdk: SwiftSdkVocabulary = swiftSdkVocabulary()) {
    this.sdkMembers = new SwiftSdkMemberTypes(sdk);
    this.sdkMembersKeepingOptionals = new SwiftSdkMemberTypes(sdk, true);
  }

  /** The SDK reader that keeps a declared `T?` an `Optional` (bd tea-rags-mcp-y99pg.33). */
  private readonly sdkMembersKeepingOptionals: SwiftSdkMemberTypes;

  /**
   * {@link sdkMemberType} with a declared `T?` kept an `Optional` of `T` —
   * for the fold that reads the source's unwrap sugar (bd tea-rags-mcp-y99pg.33).
   */
  sdkMemberTypeKeepingOptionals(receiver: SwiftNominalTypeRef, member: string, ctx: CallContext): TypeRef | undefined {
    if (this.memberReach(receiver.name, member, ctx).declared) return undefined;
    const sdk = this.sdkView(receiver, ctx);
    return this.sdkMembersKeepingOptionals.memberType(sdk.receiver, member, sdk.order, sdk.selfAliases);
  }

  /**
   * Whether `Optional` itself declares `member` — the project's `extension
   * Optional` or the SDK — so a member written straight on an optional value
   * is `Optional`'s and not the wrapped type's (bd tea-rags-mcp-y99pg.33).
   */
  optionalDeclares(member: string, ctx: CallContext): boolean {
    return (
      this.memberReach(SWIFT_OPTIONAL, member, ctx).declared || this.sdkDeclaresMember(SWIFT_OPTIONAL, member, ctx)
    );
  }

  /**
   * Whether the property `member` of `typeName` — found where
   * {@link typeOfProperty} finds it — is declared `T?` (bd tea-rags-mcp-y99pg.33).
   */
  isOptionalProperty(typeName: string, member: string, ctx: CallContext): boolean {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) =>
      this.propertyTypeOn(candidate, member, ctx),
    );
    if (scan.definingClassKey === null) return false;
    return swiftIsOptionalProperty(qualifySwiftTypeName(scan.definingClassKey, ctx), member, ctx);
  }

  /** Whether the SDK substrate declares a type of this path. */
  isSdkType(typeName: string): boolean {
    return this.sdk.hasType(typeName);
  }

  /**
   * What `receiver.member` denotes by the SDK's declaration — only when no
   * type on the receiver's lookup order declares `member` in the project,
   * whose own answer (or silence) always wins.
   */
  sdkMemberType(receiver: SwiftNominalTypeRef, member: string, ctx: CallContext): TypeRef | undefined {
    if (this.memberReach(receiver.name, member, ctx).declared) return undefined;
    const sdk = this.sdkView(receiver, ctx);
    return this.sdkMembers.memberType(sdk.receiver, member, sdk.order, sdk.selfAliases);
  }

  /** The SDK-declared type of the `index`-th parameter of the closure `receiver.member` takes, on the same terms. */
  sdkClosureParameterType(
    receiver: SwiftNominalTypeRef,
    member: string,
    index: number,
    ctx: CallContext,
  ): TypeRef | undefined {
    if (this.memberReach(receiver.name, member, ctx).declared) return undefined;
    const sdk = this.sdkView(receiver, ctx);
    return this.sdkMembers.closureParameterType(sdk.receiver, member, index, sdk.order, sdk.selfAliases);
  }

  /**
   * Whether an SDK type on `typeName`'s lookup order declares `member` —
   * the implicit-self question a bare callee asks before it may be read as a
   * module-level function (bd tea-rags-mcp-y99pg.29).
   */
  sdkDeclaresMember(typeName: string, member: string, ctx: CallContext): boolean {
    const sdk = this.sdkView({ form: "instance", name: typeName }, ctx);
    return sdk.order.some((candidate) => this.sdk.ownMembers(candidate, member).length > 0);
  }

  /** The SDK-declared type of the `index`-th parameter of the closure the module-level function `name` takes. */
  sdkFunctionClosureParameterType(name: string, index: number): TypeRef | undefined {
    return this.sdkMembers.functionClosureParameterType(name, index);
  }

  /** The instance an SDK construction `T(…)` / `T { … }` spelled `typeText` builds. */
  sdkConstructionType(typeText: string): SwiftNominalTypeRef | undefined {
    return this.sdkMembers.constructionType(typeText);
  }

  /**
   * The declared type of the property `member` on `typeName` or a superclass,
   * qualified from the type that DECLARES the property.
   *
   * A property's type is written inside its declaring type, and Swift resolves
   * that spelling from there outward: `var state: State` inside
   * `Request.MutableState` names `Request.State`, whichever file or subclass
   * later reads `mutableState.state`. The caller's own scope is the wrong place
   * to start — a `DownloadRequest` caller encloses no `State` at all — so the
   * lexical walk starts at the owner ({@link qualifySwiftTypeNameWithin}).
   */
  typeOfProperty(typeName: string, member: string, ctx: CallContext): string | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) =>
      this.propertyTypeOn(candidate, member, ctx),
    );
    if (scan.target === null || scan.definingClassKey === null) return undefined;
    return qualifySwiftTypeNameWithin(scan.target, qualifySwiftTypeName(scan.definingClassKey, ctx), ctx);
  }

  /**
   * The METHOD `member` a value of `typeName` dispatches to: the type's own
   * declaration, else the nearest superclass declaring it — the same walk
   * `typeOfProperty` makes for a property, and for the same reason. Swift
   * declares shared behaviour on a base class and calls it through the
   * subclass constantly (`DataRequest` inherits `resume()` / `cancel()` from
   * `Request`), and a bound receiver whose own type is searched alone DROPs
   * every one of those calls.
   *
   * The walk stops at the FIRST class that declares the member at all, even
   * when the strict gate then finds that declaration ambiguous (two files each
   * composing `DataRequest#resume`). Falling through to `Request#resume` there
   * would answer with the one declaration the source provably does not call.
   *
   * Given the CALL, "declares" means declares an overload the call's argument
   * labels fit (bd tea-rags-mcp-y99pg.7): Swift resolves an overload over the
   * whole hierarchy, so `uploadProgress(queue:closure:)` on a `DataRequest`
   * passes the subclass's `uploadProgress(bufferingPolicy:)` for `Request`'s.
   */
  memberOn(
    typeName: string,
    member: string,
    ctx: CallContext,
    mode: AmbiguousResolveMode,
    call?: CallRef,
  ): SymbolResolutionTarget | null {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) => {
      // The chain's keys are type names as WRITTEN; members compose under the
      // qualified id (`qualifySwiftTypeName`).
      const typeId = qualifySwiftTypeName(candidate, ctx);
      return declaresMember(typeId, member, ctx, call)
        ? { target: lookupSwiftTypeMember(typeId, member, ctx, mode, call) }
        : null;
    });
    return scan.target?.target ?? null;
  }

  /**
   * `self` inside `typeName` at `atLine` of the caller's file, with the
   * generic arguments a constrained extension there binds (bd
   * tea-rags-mcp-y99pg.34): inside `extension Protected where Value ==
   * Request.MutableState`, `self` is a `Protected<Request.MutableState>`. A
   * conformance or superclass requirement binds its parameter as a bound
   * (`ExtendedType: Bundle`). Arguments attach only when the clause binds every
   * parameter, the shape a generic argument list always has.
   */
  selfType(typeName: string, atLine: number, ctx: CallContext): SwiftNominalTypeRef {
    const self: SwiftNominalTypeRef = { form: "instance", name: typeName };
    const typeId = qualifySwiftTypeName(typeName, ctx);
    const clause = swiftWhereClauseAt(typeId, ctx.callerFile, atLine, ctx);
    const parameters = swiftGenericParameters(typeId, ctx);
    if (clause === undefined || parameters.length === 0) return self;
    const args: TypeRef[] = [];
    for (const parameter of parameters) {
      const sameType = clause.sameType?.[parameter];
      const bound = clause.bounds?.[parameter];
      const arg: TypeRef | undefined =
        sameType !== undefined
          ? this.typeOfSpelling(parseSwiftTypeText(sameType), ctx)
          : bound !== undefined
            ? { form: "instance", name: qualifySwiftTypeName(bound, ctx), upperBound: true }
            : undefined;
      if (arg === undefined) return self;
      args.push(arg);
    }
    return { ...self, args };
  }

  /**
   * The type of the stored property `member` on `receiver` when its
   * declaration types it as one of the receiver type's generic parameters —
   * that parameter's argument on the receiver, or undefined (bd
   * tea-rags-mcp-y99pg.34).
   */
  genericFieldType(receiver: TypeRef, member: string, ctx: CallContext): TypeRef | undefined {
    if ((receiver.form !== "instance" && receiver.form !== "class") || receiver.args === undefined) return undefined;
    const typeId = qualifySwiftTypeName(receiver.name, ctx);
    const parameter = swiftGenericFieldParameter(typeId, member, ctx);
    if (parameter === undefined) return undefined;
    const slot = swiftGenericParameters(typeId, ctx).indexOf(parameter);
    return slot === -1 ? undefined : receiver.args[slot];
  }

  /** A type spelling written at file scope, as a value type: optionals collapse, `[T]` is `Array<T>`. */
  private typeOfSpelling(expr: SwiftTypeExpr | undefined, ctx: CallContext): TypeRef | undefined {
    if (expr === undefined) return undefined;
    switch (expr.kind) {
      case "optional":
        return this.typeOfSpelling(expr.wrapped, ctx);
      case "array": {
        const element = this.typeOfSpelling(expr.element, ctx);
        return element === undefined
          ? { form: "instance", name: "Array" }
          : { form: "instance", name: "Array", args: [element] };
      }
      case "nominal": {
        const args = expr.args.map((arg) => this.typeOfSpelling(arg, ctx));
        const name = qualifySwiftTypeName(expr.path, ctx);
        return args.length === 0 || args.some((arg) => arg === undefined)
          ? { form: "instance", name }
          : { form: "instance", name, args: args as TypeRef[] };
      }
      case "dictionary":
      case "function":
      case "tuple":
      case "metatype":
        return undefined;
    }
  }

  /**
   * The generic arguments the property `field` of `typeName` (or of the
   * nearest ancestor declaring it) is declared with, each qualified from that
   * declaring type — `["Request.MutableState"]` for `mutableState:
   * Protected<MutableState>` inside `Request` (bd tea-rags-mcp-y99pg.13).
   */
  fieldTypeArguments(typeName: string, field: string, ctx: CallContext): readonly (string | null)[] | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) => {
      const typeId = qualifySwiftTypeName(candidate, ctx);
      const args = swiftFieldTypeArguments(typeId, field, ctx);
      return args === undefined
        ? null
        : args.map((arg) => (arg === null ? null : qualifySwiftTypeNameWithin(arg, typeId, ctx)));
    });
    return scan.target ?? undefined;
  }

  /**
   * The property WRAPPER of `typeName`'s (or the nearest ancestor's) property
   * `field` (bd tea-rags-mcp-y99pg.33): the first of its attribute types that
   * is one — a type declaring `wrappedValue` or `projectedValue`, in the
   * project or the SDK. Swift applies wrappers outermost first in written
   * order, so the first such attribute is the one `$field` projects through;
   * `@MainActor`, spelled the same way, declares neither and is skipped.
   */
  propertyWrapperOf(typeName: string, field: string, ctx: CallContext): string | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) => {
      const attributes = swiftPropertyAttributeTypes(qualifySwiftTypeName(candidate, ctx), field, ctx);
      return attributes.length === 0 ? null : { attributes };
    });
    return scan.target?.attributes.find((attribute) =>
      SWIFT_WRAPPER_MEMBERS.some(
        (member) =>
          this.typeOfProperty(attribute, member, ctx) !== undefined || this.sdkDeclaresMember(attribute, member, ctx),
      ),
    );
  }

  /**
   * The declared parameter types of the closure `typeName`'s method `member`
   * takes, found up the member-lookup chain, with the generic parameters of
   * the type that DECLARES the method (bd tea-rags-mcp-y99pg.13).
   */
  closureParameterTypes(typeName: string, member: string, ctx: CallContext): SwiftClosureSignature | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) => {
      const typeId = qualifySwiftTypeName(candidate, ctx);
      const types = swiftMemberClosureParameters(typeId, member, ctx);
      if (types === undefined) return null;
      return { types, genericParameters: swiftGenericParameters(typeId, ctx), ownerTypeId: typeId };
    });
    return scan.target ?? undefined;
  }

  /**
   * Every type a member lookup on `typeName` reads — the type itself, its
   * superclass chain and the conformances the project names for any of them —
   * each in both the spelling the chain keys it by and its qualified id, and
   * whether any of them declares `member` in any overload (bd
   * tea-rags-mcp-y99pg.11).
   *
   * The denominator question, not the resolution one: a call ARGUMENT that
   * fits no overload is still a call on a member the project declares, so no
   * call narrows the answer here.
   */
  /**
   * The types a member lookup on `typeName` reads, in order, as the chain
   * keys them — for a reader of ANOTHER declaration source (the SDK
   * substrate, bd tea-rags-mcp-y99pg.25) that must walk the same order.
   */
  lookupOrder(typeName: string, ctx: CallContext): readonly string[] {
    return this.linearizerFor(ctx).linearize(typeName).order;
  }

  memberReach(typeName: string, member: string, ctx: CallContext): SwiftMemberReach {
    const { order } = this.linearizerFor(ctx).linearize(typeName);
    const types = new Set<string>();
    let declared = false;
    for (const candidate of order) {
      const typeId = qualifySwiftTypeName(candidate, ctx);
      types.add(candidate);
      types.add(typeId);
      if (!declared && declaresMember(typeId, member, ctx)) declared = true;
    }
    return { declared, types };
  }

  /**
   * Whether `call` provably runs an SDK overload although the project declares
   * its member on the receiver's hierarchy (bd tea-rags-mcp-y99pg.25): no
   * project overload there takes the call's argument labels, and the SDK
   * declares the member on the same hierarchy — `self.init(url:cachePolicy:)`
   * inside `extension URLRequest` beside a project `init(_:method:headers:)`.
   */
  runsSdkOverload(typeName: string, call: CallRef, ctx: CallContext): boolean {
    const { order } = this.linearizerFor(ctx).linearize(typeName);
    if (order.some((candidate) => declaresMember(qualifySwiftTypeName(candidate, ctx), call.member, ctx, call))) {
      return false;
    }
    return this.sdkDeclaresMember(typeName, call.member, ctx);
  }

  /**
   * A receiver as the SDK names it, with the lookup order its SDK members are
   * found along: an extension's spelled id (`Collection<String>`,
   * `[HTTPHeader]`) reads as the nominal it re-opens.
   */
  private sdkView(receiver: SwiftNominalTypeRef, ctx: CallContext): SwiftSdkView {
    const nominal = swiftSpelledNominal(receiver.name);
    if (nominal === receiver.name) {
      const order = this.lookupOrder(receiver.name, ctx);
      return { receiver, order, selfAliases: this.selfAliasesAlong(order, ctx) };
    }
    const order = [...new Set([...this.lookupOrder(receiver.name, ctx), ...this.lookupOrder(nominal, ctx)])];
    return { receiver: { ...receiver, name: nominal }, order, selfAliases: this.selfAliasesAlong(order, ctx) };
  }

  /**
   * What `Self.X` means on a receiver whose lookup order is `order` (bd
   * tea-rags-mcp-y99pg.33): the member typealiases the project types on it
   * declare, the nearest declaration of each name winning. Each alias is
   * qualified from the type that declares it, as a property's type is
   * ({@link typeOfProperty}). An alias naming one of its type's own generic
   * parameters says nothing a bare receiver can bind, and is left out.
   */
  private selfAliasesAlong(order: readonly string[], ctx: CallContext): SwiftSelfAliases | undefined {
    let out: Map<string, TypeRef> | undefined;
    for (const candidate of order) {
      const typeId = qualifySwiftTypeName(candidate, ctx);
      const aliases = swiftMemberTypeAliases(typeId, ctx);
      if (aliases === undefined) continue;
      const generics = swiftGenericParameters(typeId, ctx);
      for (const [alias, aliased] of aliases) {
        if (out?.has(alias) === true || generics.includes(aliased)) continue;
        out ??= new Map();
        out.set(alias, { form: "instance", name: qualifySwiftTypeNameWithin(aliased, typeId, ctx) });
      }
    }
    return out;
  }

  /**
   * The field channels key a type by its OWN name (`MutableState`), the name
   * its declaration spells; a qualified receiver (`Request.MutableState`) reads
   * them under its last segment.
   */
  private propertyTypeOn(typeName: string, member: string, ctx: CallContext): string | null {
    const key = typeName.slice(typeName.lastIndexOf(".") + 1);
    return (
      identifierEntry(identifierEntry(ctx.classFieldTypes, key), member) ??
      identifierEntry(this.fields.fieldsOf(key, ctx), member) ??
      null
    );
  }

  /**
   * What a call of `member` on a `typeName` value returns (bd
   * tea-rags-mcp-kkwg3, y99pg.18): the declared return of the declaration the
   * call lands on, else — for an overload set the hop cannot pick among,
   * having no argument labels — the return EVERY overload of the nearest
   * declaring type agrees on (`validate(statusCode:)`, `validate(contentType:)`
   * and `validate()` all return `Self`). A `-> Self` return is the
   * receiver's own type, substituted here so the marker never leaves this
   * method.
   */
  memberReturnType(typeName: string, member: string, ctx: CallContext): TypeRef | undefined {
    const callee = this.memberOn(typeName, member, ctx, "strict")?.targetSymbolId;
    const returned = callee
      ? identifierEntry(ctx.structuredReturnTypes, callee)
      : this.agreedReturn(typeName, member, ctx);
    return returned?.form === "instance" && returned.name === SWIFT_SELF_RETURN
      ? { form: "instance", name: typeName }
      : returned;
  }

  private agreedReturn(typeName: string, member: string, ctx: CallContext): TypeRef | undefined {
    const scan = findMemberInAncestorChain(typeName, this.linearizerFor(ctx), (candidate) => {
      const typeId = qualifySwiftTypeName(candidate, ctx);
      const overloads = [
        ...lookupSwiftOverloads(ctx, `${typeId}#${member}`),
        ...lookupSwiftOverloads(ctx, `${typeId}.${member}`),
      ];
      return overloads.length > 0 ? { overloads } : null;
    });
    const overloads = scan.target?.overloads;
    if (overloads === undefined) return undefined;
    const returns = overloads.map((def) => identifierEntry(ctx.structuredReturnTypes, def.symbolId));
    const [first] = returns;
    if (first === undefined) return undefined;
    return returns.every((r) => r !== undefined && sameTypeRef(r, first)) ? first : undefined;
  }

  private linearizerFor(ctx: CallContext): AncestorLinearizer<CallContext> {
    const hit = this.linearizers.get(ctx.runScope, ctx);
    if (hit !== undefined) return hit;
    const fresh = createAncestorLinearizer(ctx, SWIFT_MEMBER_LOOKUP_POLICY);
    this.linearizers.set(ctx.runScope, ctx, fresh);
    return fresh;
  }
}

/** Two declared returns name the same nominal — only the forms Swift publishes ever agree. */
function sameTypeRef(a: TypeRef, b: TypeRef): boolean {
  if ((a.form !== "instance" && a.form !== "class") || (b.form !== "instance" && b.form !== "class")) return false;
  return a.form === b.form && a.name === b.name;
}

/** The standard library's `Optional`, which a declared `T?` is (bd tea-rags-mcp-y99pg.33). */
const SWIFT_OPTIONAL = "Optional";

/** The members that make a type a property wrapper: Swift requires `wrappedValue`, and `$x` reads `projectedValue`. */
const SWIFT_WRAPPER_MEMBERS: readonly string[] = ["wrappedValue", "projectedValue"];

/** The `structuredReturnTypes` marker the walker publishes for `-> Self` (bd tea-rags-mcp-y99pg.18). */
const SWIFT_SELF_RETURN = "Self";

/** Whether `typeName` declares `member` in either spelling — one the call fits, given one — whatever the cardinality. */
function declaresMember(typeName: string, member: string, ctx: CallContext, call?: CallRef): boolean {
  return (
    swiftMemberCandidates(ctx, `${typeName}#${member}`, call).length > 0 ||
    swiftMemberCandidates(ctx, `${typeName}.${member}`, call).length > 0
  );
}
