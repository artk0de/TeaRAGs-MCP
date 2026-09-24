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
 *     `Array.SubSequence` → `ArraySlice<Element>`);
 *   - a generic parameter nothing binds, by its constraint — the protocol every
 *     value of it is (`Result`'s `Failure: Error` → `Error`) — marked
 *     `upperBound`: the constraint's members are callable on the value, but its
 *     own type may add more, so the denominator must not read it as proof;
 *   - an optional by what it wraps, the collapse every receiver gets.
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

/** A found SDK member: the receiver it was found for (possibly promoted to `Optional`) and its shapes. */
interface SwiftSdkMemberFound {
  readonly receiver: SwiftNominalTypeRef;
  readonly owner: SwiftSdkType;
  readonly shapes: readonly SwiftSdkMember[];
}

/** Generic parameter name → what it is bound to in one substitution. */
type SwiftTypeBindings = ReadonlyMap<string, TypeRef | undefined>;

export class SwiftSdkMemberTypes {
  constructor(private readonly sdk: SwiftSdkVocabulary) {}

  /**
   * The type of `receiver.member` when an SDK type on `order` (the receiver's
   * member-lookup order) declares it: a property's declared type, or the
   * return every value-returning overload agrees on. Static members answer a
   * `class` receiver, instance members an `instance` one; an enum case is a
   * value of its own type.
   */
  memberType(receiver: SwiftNominalTypeRef, member: string, order: readonly string[]): TypeRef | undefined {
    const found = this.find(receiver, member, order);
    if (found === undefined) return undefined;
    const shapes = found.shapes.filter(
      (shape) => shape.kind !== "init" && shape.isStatic === (found.receiver.form === "class"),
    );
    let agreed: TypeRef | undefined;
    for (const shape of shapes) {
      if (shape.kind === "case") return boundedBy(found.receiver, { form: "instance", name: found.owner.path });
      // A hop's value is USED, so a `Void` overload is not the one called.
      if (shape.returns === null) continue;
      const type = this.typeOfText(shape.returns, found.receiver, found.owner, shape);
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
  ): TypeRef | undefined {
    const found = this.find(receiver, member, order);
    if (found === undefined) return undefined;
    return boundedBy(found.receiver, this.agreedClosureParameter(found.shapes, index, found.receiver, found.owner));
  }

  /**
   * The same question for the module-level function `name` (bd
   * tea-rags-mcp-y99pg.29): `withCheckedContinuation { continuation in … }`
   * calls its closure with a `CheckedContinuation`. Only the function's own
   * generic parameters are in scope, each bound by its constraint.
   */
  functionClosureParameterType(name: string, index: number): TypeRef | undefined {
    return this.agreedClosureParameter(this.sdk.globalFunctions(name), index, undefined, undefined);
  }

  /** The `index`-th parameter type of the last closure every shape taking one agrees on. */
  private agreedClosureParameter(
    shapes: readonly SwiftSdkMember[],
    index: number,
    receiver: SwiftNominalTypeRef | undefined,
    owner: SwiftSdkType | undefined,
  ): TypeRef | undefined {
    let agreed: TypeRef | undefined;
    for (const shape of shapes) {
      const closure = [...shape.closureParameters].reverse().find((text) => text !== "");
      if (closure === undefined) continue;
      const parsed = parseSwiftTypeText(closure);
      const fn = parsed?.kind === "optional" ? parsed.wrapped : parsed;
      if (fn?.kind !== "function" || index >= fn.params.length) continue;
      const type = this.typeOf(fn.params[index], receiver, owner, shape);
      if (type === undefined) return undefined;
      if (agreed !== undefined && !sameNominal(agreed, type)) return undefined;
      agreed ??= type;
    }
    return agreed;
  }

  /**
   * A construction's value: `T(…)` / `T { … }` is an instance of `T`, with the
   * generic arguments the spelling states. Only an SDK type answers here.
   */
  constructionType(typeText: string): SwiftNominalTypeRef | undefined {
    const parsed = parseSwiftTypeText(typeText);
    if (parsed?.kind !== "nominal" || !this.sdk.hasType(parsed.path)) return undefined;
    const args = parsed.args.map((arg) => this.typeOf(arg, undefined, undefined, undefined));
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
  ): SwiftSdkMemberFound | undefined {
    for (const candidate of order) {
      const shapes = this.sdk.ownMembers(candidate, member);
      const owner = this.sdk.type(candidate);
      if (shapes.length > 0 && owner !== undefined) return { receiver, owner, shapes };
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
    receiver: SwiftNominalTypeRef,
    owner: SwiftSdkType,
    shape: SwiftSdkMember,
  ): TypeRef | undefined {
    const parsed = parseSwiftTypeText(text);
    return parsed === undefined ? undefined : this.typeOf(parsed, receiver, owner, shape);
  }

  /** A parsed SDK type, substituted for one receiver, declaring type and member shape. */
  private typeOf(
    expr: SwiftTypeExpr,
    receiver: SwiftNominalTypeRef | undefined,
    owner: SwiftSdkType | undefined,
    shape: SwiftSdkMember | undefined,
  ): TypeRef | undefined {
    const bindings = this.bindingsOf(receiver, owner, shape);
    return this.substitute(expr, bindings, receiver, 0);
  }

  /**
   * What each generic parameter in scope of a member denotes: the declaring
   * type's own, bound by the receiver's arguments when the receiver IS that
   * type, else by its constraint; the member's own, by theirs.
   */
  private bindingsOf(
    receiver: SwiftNominalTypeRef | undefined,
    owner: SwiftSdkType | undefined,
    shape: SwiftSdkMember | undefined,
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
    return bindings;
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
      case "optional":
        return this.substitute(expr.wrapped, bindings, receiver, depth + 1);
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
    return this.substitute(parsed, this.bindingsOf(receiver, alias.owner, undefined), receiver, depth + 1);
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
  if (type === undefined || receiver.form === "union" || receiver.form === "container" || receiver.form === "nil") {
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
