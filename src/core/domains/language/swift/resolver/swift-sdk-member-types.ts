/**
 * What a member of an SDK type denotes — the SDK half of the receiver fold's
 * `memberTypeOf`, and of closure-parameter typing (bd tea-rags-mcp-y99pg.25).
 *
 * The project channels say what a PROJECT member returns; nothing in the
 * index says that `Locale.preferredLanguages` is a `[String]`, that
 * `prefix(_:)` on it is an `ArraySlice<String>`, or that the closure
 * `Result.mapError` takes is called with the result's `Failure`. The generated
 * SDK substrate does, as declared type TEXT with the declaring type's generic
 * parameters in it. This module reads that text and substitutes:
 *
 *   - the declaring type's own generic parameters, bound positionally by the
 *     receiver's generic arguments (`Result<URLRequest, Error>.get()` →
 *     `URLRequest`);
 *   - `Self` by the receiver, and `Self.X` by the receiver's member alias or
 *     generic parameter `X` (`Set<Request>`'s `Self.Element` → `Request`,
 *     `Array.SubSequence` → `ArraySlice<Element>`) — on a PROJECT conformer,
 *     by the member typealias its own declaration states (bd
 *     tea-rags-mcp-y99pg.33);
 *   - a generic parameter nothing binds, by its constraint — the protocol every
 *     value of it is (`Result`'s `Failure: Error` → `Error`) — marked
 *     `upperBound`: the constraint's members are callable on the value, but its
 *     own type may add more, so the denominator must not read it as proof;
 *   - an optional by what it wraps, the collapse every NORMALIZED receiver
 *     gets — the fold over a receiver as written keeps it an `Optional`
 *     (`keepsOptionals`, bd tea-rags-mcp-y99pg.33).
 *
 * A result it cannot build answers `undefined`, and so does a member whose
 * overloads disagree on it: the fold stops there, which is the answer that
 * cannot be wrong.
 */

import type { TypeRef } from "../../../../contracts/types/language.js";
import type { SwiftSdkMember, SwiftSdkType, SwiftSdkVocabulary } from "../vocabulary/sdk-vocabulary.js";
import { parseSwiftTypeText, type SwiftTypeExpr } from "../vocabulary/swift-type-text.js";

/** A nominal receiver: the only form an SDK member is looked up on. */
export type SwiftNominalTypeRef = Extract<TypeRef, { form: "class" | "instance" }>;

/**
 * A project receiver's member typealiases, alias name → the type it names
 * (bd tea-rags-mcp-y99pg.33): what `Self.<alias>` means on that receiver.
 */
export type SwiftSelfAliases = ReadonlyMap<string, TypeRef>;

/** What one SDK member's types are substituted against: the receiver, the declaring type, `Self`'s aliases. */
interface SwiftSdkSubstitutionScope {
  readonly receiver: SwiftNominalTypeRef;
  readonly owner: SwiftSdkType;
  readonly selfAliases?: SwiftSelfAliases;
}

/** A found SDK member: the receiver it was found for (possibly promoted to `Optional`) and its shapes. */
interface SwiftSdkMemberFound extends SwiftSdkSubstitutionScope {
  readonly shapes: readonly SwiftSdkMember[];
}

/** Generic parameter name → what it is bound to in one substitution. */
type SwiftTypeBindings = ReadonlyMap<string, TypeRef | undefined>;

export class SwiftSdkMemberTypes {
  /**
   * @param keepsOptionals Whether a declared `T?` stays an `Optional` of `T`
   *   (bd tea-rags-mcp-y99pg.33) — for a reader that knows where the source
   *   unwraps it — instead of collapsing to `T`, which is every other reader's
   *   view.
   */
  constructor(
    private readonly sdk: SwiftSdkVocabulary,
    private readonly keepsOptionals = false,
  ) {}

  /**
   * The type of `receiver.member` when an SDK type on `order` (the receiver's
   * member-lookup order) declares it: a property's declared type, or the
   * return every value-returning overload agrees on. Static members answer a
   * `class` receiver, instance members an `instance` one; an enum case is a
   * value of its own type.
   */
  memberType(
    receiver: SwiftNominalTypeRef,
    member: string,
    order: readonly string[],
    selfAliases?: SwiftSelfAliases,
  ): TypeRef | undefined {
    const found = this.find(receiver, member, order, selfAliases);
    if (found === undefined) return undefined;
    const shapes = found.shapes.filter(
      (shape) => shape.kind !== "init" && shape.isStatic === (found.receiver.form === "class"),
    );
    let agreed: TypeRef | undefined;
    for (const shape of shapes) {
      if (shape.kind === "case") return boundedBy(found.receiver, { form: "instance", name: found.owner.path });
      // A hop's value is USED, so a `Void` overload is not the one called.
      if (shape.returns === null) continue;
      const type = this.typeOfText(shape.returns, found, shape);
      if (type === undefined) return undefined;
      if (agreed !== undefined && !sameNominal(agreed, type)) return undefined;
      agreed ??= type;
    }
    return boundedBy(found.receiver, agreed);
  }

  /**
   * The type of the `index`-th parameter of the closure `receiver.member`
   * takes — its last function-typed parameter, which is the one a trailing
   * closure fills — when every overload taking one agrees.
   */
  closureParameterType(
    receiver: SwiftNominalTypeRef,
    member: string,
    index: number,
    order: readonly string[],
    selfAliases?: SwiftSelfAliases,
  ): TypeRef | undefined {
    const found = this.find(receiver, member, order, selfAliases);
    if (found === undefined) return undefined;
    return boundedBy(found.receiver, this.agreedClosureParameter(found.shapes, index, found));
  }

  /**
   * The same question for the module-level function `name` (bd
   * tea-rags-mcp-y99pg.29): `withCheckedContinuation { continuation in … }`
   * calls its closure with a `CheckedContinuation`. Only the function's own
   * generic parameters are in scope, each bound by its constraint.
   */
  functionClosureParameterType(name: string, index: number): TypeRef | undefined {
    return this.agreedClosureParameter(this.sdk.globalFunctions(name), index, undefined);
  }

  /**
   * What the standard library's free function `fullName` — labels included,
   * `stride(from:to:by:)` — returns, when its overloads agree (bd
   * tea-rags-mcp-3j7rg). Only the function's own generic parameters are in
   * scope, each bound by its constraint and so marked as a bound:
   * `StrideTo<T>` with `T: Strideable` is a `StrideTo` whose element is known
   * only as a `Strideable`.
   */
  functionReturnType(fullName: string): TypeRef | undefined {
    let agreed: TypeRef | undefined;
    for (const shape of this.sdk.labelledGlobalFunction(fullName)) {
      if (shape.returns === null) continue;
      const type = this.typeOfText(shape.returns, undefined, shape);
      if (type === undefined) return undefined;
      if (agreed !== undefined && !sameNominal(agreed, type)) return undefined;
      agreed ??= type;
    }
    return agreed;
  }

  /** The `index`-th parameter type of the last closure every shape taking one agrees on. */
  private agreedClosureParameter(
    shapes: readonly SwiftSdkMember[],
    index: number,
    found: SwiftSdkSubstitutionScope | undefined,
  ): TypeRef | undefined {
    let agreed: TypeRef | undefined;
    for (const shape of shapes) {
      const closure = [...shape.closureParameters].reverse().find((text) => text !== "");
      if (closure === undefined) continue;
      const parsed = parseSwiftTypeText(closure);
      const fn = parsed?.kind === "optional" ? parsed.wrapped : parsed;
      if (fn?.kind !== "function" || index >= fn.params.length) continue;
      const type = this.typeOf(fn.params[index], found, shape);
      if (type === undefined) return undefined;
      if (agreed !== undefined && !sameNominal(agreed, type)) return undefined;
      agreed ??= type;
    }
    return agreed;
  }

  /**
   * The element a `for` loop over `sequence` draws: its `Element` — a generic
   * parameter of that name (`Set<Request>` → `Request`) or the alias its
   * lookup order declares (bd tea-rags-mcp-y99pg.37). Undefined for a type the
   * substrate does not declare, or one whose argument is unknown.
   */
  sequenceElementType(sequence: SwiftNominalTypeRef): TypeRef | undefined {
    if (sequence.form !== "instance") return undefined;
    const element = this.associatedType(sequence, "Element", 0);
    return element?.form === "instance" && element.upperBound !== true ? element : undefined;
  }

  /**
   * A construction's value: `T(…)` / `T { … }` is an instance of `T`, with the
   * generic arguments the spelling states. Only an SDK type answers here.
   */
  constructionType(typeText: string): SwiftNominalTypeRef | undefined {
    const parsed = parseSwiftTypeText(typeText);
    if (parsed?.kind !== "nominal" || !this.sdk.hasType(parsed.path)) return undefined;
    const args = parsed.args.map((arg) => this.typeOf(arg, undefined, undefined));
    return withArgs({ form: "instance", name: parsed.path }, args);
  }

  /**
   * The SDK member `member` of `receiver`: the first type on `order` the
   * substrate declares it on. A receiver none of whose types declares it,
   * where `Optional` does, is an optional read through its wrapped type —
   * `error.map { … }` on an `Error?` the walker collapsed to `Error`.
   */
  private find(
    receiver: SwiftNominalTypeRef,
    member: string,
    order: readonly string[],
    selfAliases: SwiftSelfAliases | undefined,
  ): SwiftSdkMemberFound | undefined {
    for (const candidate of order) {
      const shapes = this.sdk.ownMembers(candidate, member);
      const owner = this.sdk.type(candidate);
      if (shapes.length > 0 && owner !== undefined) return { receiver, owner, shapes, selfAliases };
    }
    if (receiver.form !== "instance") return undefined;
    const optional = this.sdk.findMember("Optional", member);
    if (optional === undefined) return undefined;
    return {
      receiver: { form: "instance", name: "Optional", args: [receiver] },
      owner: optional.owner,
      shapes: optional.members,
    };
  }

  private typeOfText(
    text: string,
    found: SwiftSdkSubstitutionScope | undefined,
    shape: SwiftSdkMember,
  ): TypeRef | undefined {
    const parsed = parseSwiftTypeText(text);
    return parsed === undefined ? undefined : this.typeOf(parsed, found, shape);
  }

  /** A parsed SDK type, substituted for one receiver, declaring type and member shape. */
  private typeOf(
    expr: SwiftTypeExpr,
    found: SwiftSdkSubstitutionScope | undefined,
    shape: SwiftSdkMember | undefined,
  ): TypeRef | undefined {
    const bindings = this.bindingsOf(found?.receiver, found?.owner, shape, found?.selfAliases);
    return this.substitute(expr, bindings, found?.receiver, 0);
  }

  /**
   * What each generic parameter in scope of a member denotes: the declaring
   * type's own, bound by the receiver's arguments when the receiver IS that
   * type, else by its constraint; the member's own, by theirs. A PROJECT
   * receiver's own member typealiases bind `Self.X` (bd tea-rags-mcp-y99pg.33):
   * the substrate knows nothing of the conformer, so they are its only
   * statement of what an associated type is on it.
   */
  private bindingsOf(
    receiver: SwiftNominalTypeRef | undefined,
    owner: SwiftSdkType | undefined,
    shape: SwiftSdkMember | undefined,
    selfAliases: SwiftSelfAliases | undefined,
  ): SwiftTypeBindings {
    const bindings = new Map<string, TypeRef | undefined>();
    if (owner !== undefined) {
      owner.genericParameters.forEach((name, i) => {
        const argument = receiver?.name === owner.path ? receiver.args?.[i] : undefined;
        bindings.set(name, argument ?? this.constraintType(owner.genericConstraints[name]));
      });
    }
    for (const [name, constraint] of shape?.genericParameters ?? []) {
      bindings.set(name, this.constraintType(constraint ?? undefined));
    }
    for (const [name, type] of this.soleRequirementDefaults(receiver, owner)) bindings.set(`Self.${name}`, type);
    for (const [name, type] of selfAliases ?? []) bindings.set(`Self.${name}`, type);
    return bindings;
  }

  /**
   * The associated-type DEFAULTS of a protocol whose one requirement is the
   * member being read, for a PROJECT conformer (bd tea-rags-mcp-3j7rg):
   * `IndicatorSlot.allCases` on a project `enum IndicatorSlot: CaseIterable`
   * is `[IndicatorSlot]`.
   *
   * An associated type is fixed by the conformer's own typealias (which
   * `selfAliases` states and overrides this), else INFERRED from its witnesses
   * to the protocol's requirements, else the default. The member reaching
   * here is the SDK's — the project declares none on the conformer's
   * hierarchy, or the lookup would have answered from the project — and it is
   * the protocol's only requirement, so no witness exists to infer from: the
   * default is what the compiler synthesizes. A protocol with other
   * requirements answers nothing, since a witness to one of those may fix the
   * type (`Sequence.Iterator` follows `makeIterator()`). So does an SDK
   * receiver, whose aliases the substrate states itself, and a value known
   * only by a bound, whose conformer is unknown.
   */
  private soleRequirementDefaults(
    receiver: SwiftNominalTypeRef | undefined,
    owner: SwiftSdkType | undefined,
  ): ReadonlyMap<string, TypeRef> {
    const out = new Map<string, TypeRef>();
    if (receiver === undefined || receiver.upperBound === true || this.sdk.hasType(receiver.name)) return out;
    if (owner?.kind !== "protocol" || owner.memberNames.length !== 1) return out;
    const self = { ...receiver, form: "instance" as const };
    for (const [name, text] of Object.entries(owner.aliases)) {
      // `[Self] where Self == Self.AllCases.Element`: the clause constrains, the type is before it.
      const parsed = parseSwiftTypeText(text.split(/\swhere\s/)[0]);
      const type = parsed === undefined ? undefined : this.substitute(parsed, new Map(), self, 1);
      if (type !== undefined) out.set(name, type);
    }
    return out;
  }

  /** A constraint as the value type it admits: a protocol or class the substrate declares. */
  private constraintType(constraint: string | undefined): TypeRef | undefined {
    if (constraint === undefined || !this.sdk.hasType(constraint)) return undefined;
    return { form: "instance", name: constraint, upperBound: true };
  }

  private substitute(
    expr: SwiftTypeExpr,
    bindings: SwiftTypeBindings,
    receiver: SwiftNominalTypeRef | undefined,
    depth: number,
  ): TypeRef | undefined {
    if (depth > SWIFT_SDK_SUBSTITUTION_DEPTH) return undefined;
    switch (expr.kind) {
      case "optional": {
        const wrapped = this.substitute(expr.wrapped, bindings, receiver, depth + 1);
        return this.keepsOptionals ? withArgs({ form: "instance", name: "Optional" }, [wrapped]) : wrapped;
      }
      case "array":
        return withArgs({ form: "instance", name: "Array" }, [
          this.substitute(expr.element, bindings, receiver, depth + 1),
        ]);
      case "dictionary":
        return withArgs({ form: "instance", name: "Dictionary" }, [
          this.substitute(expr.key, bindings, receiver, depth + 1),
          this.substitute(expr.value, bindings, receiver, depth + 1),
        ]);
      case "metatype": {
        const instance = this.substitute(expr.instance, bindings, receiver, depth + 1);
        return instance?.form === "instance" ? { form: "class", name: instance.name } : undefined;
      }
      case "function":
      case "tuple":
        return undefined;
      case "nominal":
        return this.substituteNominal(expr, bindings, receiver, depth);
    }
  }

  private substituteNominal(
    expr: Extract<SwiftTypeExpr, { kind: "nominal" }>,
    bindings: SwiftTypeBindings,
    receiver: SwiftNominalTypeRef | undefined,
    depth: number,
  ): TypeRef | undefined {
    const { path } = expr;
    if (path === "Self") return receiver === undefined ? undefined : { ...receiver, form: "instance" };
    if (path.startsWith("Self.")) {
      if (bindings.has(path)) return bindings.get(path);
      return receiver === undefined ? undefined : this.associatedType(receiver, path.slice("Self.".length), depth);
    }
    if (bindings.has(path)) return bindings.get(path);
    // `T.Element` on a member generic: nothing binds `T`'s associated types.
    if (bindings.has(path.slice(0, path.indexOf(".")))) return undefined;
    if (!this.sdk.hasType(path)) return undefined;
    const args = expr.args.map((arg) => this.substitute(arg, bindings, receiver, depth + 1));
    return withArgs({ form: "instance", name: path }, args);
  }

  /**
   * `Self.X` on `receiver`: its generic parameter `X`, or the member alias /
   * associated-type default `X` its lookup order first declares.
   */
  private associatedType(receiver: SwiftNominalTypeRef, name: string, depth: number): TypeRef | undefined {
    if (name.includes(".")) return undefined;
    const type = this.sdk.type(receiver.name);
    if (type === undefined) return undefined;
    const slot = type.genericParameters.indexOf(name);
    if (slot !== -1) return receiver.args?.[slot] ?? this.constraintType(type.genericConstraints[name]);
    const alias = this.sdk.findAlias(receiver.name, name);
    if (alias === undefined) return undefined;
    const parsed = parseSwiftTypeText(alias.text);
    if (parsed === undefined) return undefined;
    return this.substitute(parsed, this.bindingsOf(receiver, alias.owner, undefined, undefined), receiver, depth + 1);
  }
}

/** How deep an alias may expand into another before the substitution gives up. */
const SWIFT_SDK_SUBSTITUTION_DEPTH = 8;

/** `nominal` with `args` attached only when every argument is known. */
function withArgs(nominal: SwiftNominalTypeRef, args: readonly (TypeRef | undefined)[]): SwiftNominalTypeRef {
  if (args.length === 0 || args.some((arg) => arg === undefined)) return nominal;
  return { ...nominal, args: args as readonly TypeRef[] };
}

/**
 * `type`, read off a receiver: a member of a value known only by a bound is
 * itself known only as the member the BOUND declares, so the mark carries.
 */
export function boundedBy(receiver: TypeRef, type: TypeRef | undefined): TypeRef | undefined {
  if (
    type === undefined ||
    receiver.form === "union" ||
    receiver.form === "container" ||
    receiver.form === "tuple" ||
    receiver.form === "nil"
  ) {
    return type;
  }
  if (receiver.upperBound !== true || (type.form !== "class" && type.form !== "instance")) return type;
  return { ...type, upperBound: true };
}

function sameNominal(a: TypeRef, b: TypeRef): boolean {
  return (
    (a.form === "instance" || a.form === "class") &&
    (b.form === "instance" || b.form === "class") &&
    a.form === b.form &&
    a.name === b.name
  );
}
