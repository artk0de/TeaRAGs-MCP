/**
 * What a type body says a USE of the type in another file needs in order to
 * type a closure parameter or bind a generic: the generic member facts
 * (`swiftGenericMemberFacts`) and the readers it folds — field constructions,
 * generic initializers, closure parameter types, the closure-result rule —
 * plus the generic-argument spelling those readers share.
 */

import { createIdentifierRecord } from "../../../../contracts/identifier-record.js";
import type { AstNode } from "../../../../contracts/types/ast.js";
import type { GenericInitializerFact, SwiftFieldConstruction } from "../../../../contracts/types/codegraph.js";
import {
  singleIdentifierPatternName,
  SWIFT_TYPE_NAME_TEXT,
  swiftFunctionTypeNode,
  swiftParameterTypeNode,
  swiftTypeNodeAfter,
  swiftTypeParameterNames,
} from "./shared.js";
import {
  constructedTypeFact,
  swiftGenericConstraint,
  swiftGenericResolvedFact,
  swiftTypeFactOf,
} from "./type-evidence.js";

/**
 * What a type body says that a USE of the type in another file needs in
 * order to type a closure parameter (bd tea-rags-mcp-y99pg.13): the generic
 * arguments its stored properties are declared with, and the parameter types
 * of the one closure each of its methods takes. Both are read positionally —
 * `type_arguments` and `tuple_type_item` children, never fields — for the
 * materialization hazard {@link swiftTypeNodeAfter} documents.
 */
export function swiftGenericMemberFacts(
  node: AstNode,
  genericParameters: readonly string[],
): {
  fieldTypeArguments?: Record<string, (string | null)[]>;
  fieldConstructions?: Record<string, SwiftFieldConstruction>;
  memberClosureParameters?: Record<string, (string | null)[] | null>;
  genericInitializers?: GenericInitializerFact[];
  genericFieldParameters?: Record<string, string>;
  closureResultMembers?: string[];
} {
  const body = node.childForFieldName("body");
  if (!body) return {};
  const fields = createIdentifierRecord<(string | null)[]>();
  const genericFields = createIdentifierRecord<string>();
  let anyGenericField = false;
  const constructions = createIdentifierRecord<SwiftFieldConstruction>();
  const closures = createIdentifierRecord<(string | null)[] | null>();
  const initializers: GenericInitializerFact[] = [];
  const closureResults = new Map<string, boolean>();
  let anyField = false;
  let anyConstruction = false;
  let anyClosure = false;
  for (const member of body.children) {
    if (member.type === "property_declaration") {
      const name = singleIdentifierPatternName(member.childForFieldName("name"));
      if (!name) continue;
      const annotation = member.children.find((c) => c.type === "type_annotation");
      const value = annotation ? null : member.childForFieldName("value");
      // `Protected<[T]>(…)` spells its arguments on the construction (bd tea-rags-mcp-y99pg.26).
      const typeNode = annotation
        ? swiftTypeNodeAfter(annotation, ":")
        : value?.type === "constructor_expression"
          ? (value.namedChildren.find((c) => c.type === "user_type") ?? null)
          : null;
      // `var value: Value` / `Value?` — typed by whatever a receiver binds the parameter to (bd tea-rags-mcp-y99pg.34).
      const unwrapped = typeNode?.type === "optional_type" ? (typeNode.namedChildren[0] ?? null) : typeNode;
      if (unwrapped?.type === "user_type" && genericParameters.includes(unwrapped.text.trim())) {
        genericFields[name] = unwrapped.text.trim();
        anyGenericField = true;
        continue;
      }
      // `[K: V]` / `[T]` spell `Dictionary<K, V>` / `Array<T>`'s arguments (bd tea-rags-mcp-y99pg.39).
      const args =
        typeNode?.type === "user_type"
          ? typeNode.children.find((c) => c.type === "type_arguments")
          : typeNode?.type === "array_type" || typeNode?.type === "dictionary_type"
            ? typeNode
            : null;
      if (args) {
        fields[name] = args.namedChildren.map((arg) => swiftTypeFactOf(arg).nominal);
        anyField = true;
        continue;
      }
      const construction = value ? swiftFieldConstruction(value) : null;
      if (construction) {
        constructions[name] = construction;
        anyConstruction = true;
      }
      continue;
    }
    if (member.type === "init_declaration") {
      const initializer = swiftGenericInitializer(member, genericParameters);
      if (initializer) initializers.push(initializer);
    } else if (member.type !== "function_declaration" && member.type !== "protocol_function_declaration") continue;
    // An initializer publishes under `init`, the member a construction's
    // closure is read off (bd tea-rags-mcp-y99pg.29).
    const name = member.type === "init_declaration" ? "init" : member.childForFieldName("name")?.text;
    if (name && member.type !== "init_declaration") {
      const returnsClosureResult = swiftReturnsClosureResult(member);
      closureResults.set(name, (closureResults.get(name) ?? true) && returnsClosureResult);
    }
    const types = name ? swiftClosureParameterTypeNames(member, genericParameters) : undefined;
    if (!name || types === undefined) continue;
    anyClosure = true;
    if (!Object.hasOwn(closures, name)) closures[name] = types;
    else if (!sameSwiftTypeNames(closures[name], types)) closures[name] = null;
  }
  const closureResultMembers = [...closureResults].filter(([, every]) => every).map(([name]) => name);
  return {
    ...(closureResultMembers.length > 0 ? { closureResultMembers } : {}),
    ...(anyField ? { fieldTypeArguments: fields } : {}),
    ...(anyConstruction ? { fieldConstructions: constructions } : {}),
    ...(anyClosure ? { memberClosureParameters: closures } : {}),
    ...(initializers.length > 0 ? { genericInitializers: initializers } : {}),
    ...(anyGenericField ? { genericFieldParameters: genericFields } : {}),
  };
}

/**
 * `Protected(State())` → the constructed type and each argument's label and
 * constructed nominal — null for anything but a CapWords construction with at
 * least one argument of known type (bd tea-rags-mcp-y99pg.26).
 */
function swiftFieldConstruction(value: AstNode): SwiftFieldConstruction | null {
  if (value.type !== "call_expression") return null;
  const callee = value.namedChildren.find((c) => c.type !== "call_suffix");
  if (callee?.type !== "simple_identifier" || !SWIFT_TYPE_NAME_TEXT.test(callee.text)) return null;
  const suffix = value.namedChildren.find((c) => c.type === "call_suffix");
  const list = suffix?.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [];
  const args: { label: string | null; type: string | null }[] = [];
  for (const arg of list) {
    if (arg.type !== "value_argument") continue;
    const label = arg.children.find((c) => c.type === "value_argument_label")?.text ?? null;
    const expression = arg.namedChildren.filter((c) => c.type !== "value_argument_label").at(-1) ?? null;
    args.push({ label, type: constructedTypeFact(expression).nominal });
  }
  return args.some((arg) => arg.type !== null) ? { type: callee.text, arguments: args } : null;
}

/**
 * An `init` whose parameters include one typed exactly as a generic parameter
 * of the enclosing type: its labels and what each position binds. Read
 * positionally, as every Swift parameter here.
 */
function swiftGenericInitializer(init: AstNode, genericParameters: readonly string[]): GenericInitializerFact | null {
  if (genericParameters.length === 0) return null;
  const labels: (string | null)[] = [];
  const binds: (string | null)[] = [];
  for (const parameter of init.children) {
    if (parameter.type !== "parameter") continue;
    const colon = parameter.children.findIndex((c) => c.type === ":");
    const names = parameter.children
      .slice(0, colon === -1 ? undefined : colon)
      .filter((c) => c.type === "simple_identifier")
      .map((c) => c.text);
    labels.push(names[0] === "_" ? null : (names[0] ?? null));
    const typeNode = swiftParameterTypeNode(parameter);
    const written = typeNode?.type === "user_type" ? typeNode.text.trim() : undefined;
    binds.push(written !== undefined && genericParameters.includes(written) ? written : null);
  }
  return binds.some((bound) => bound !== null) ? { labels, binds } : null;
}

/** Whether two overloads state the same closure parameter types; `null` (poisoned) equals nothing. */
function sameSwiftTypeNames(a: readonly (string | null)[] | null, b: readonly (string | null)[] | null): boolean {
  if (a === null) return false;
  if (b === null) return false;
  return a.length === b.length && a.every((name, i) => name === b[i]);
}

/**
 * The declared parameter types of the ONE function-typed parameter `fn`
 * takes that itself takes a parameter — `undefined` when it takes none,
 * `null` when it takes two or more.
 * A name the enclosing type declares as a generic parameter is kept as that
 * name, to be bound by a receiver's type arguments; a method's own generic
 * parameter reads as its constraint, or nothing.
 */
function swiftClosureParameterTypeNames(
  fn: AstNode,
  genericParameters: readonly string[],
): (string | null)[] | null | undefined {
  let found: (string | null)[] | null | undefined;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    const params = functionType.children.find((c) => c.type === "tuple_type");
    // A slot whose function takes nothing (`onTermination: (() -> Void)?`)
    // can never receive a closure that names a parameter, so it does not
    // compete for one (bd tea-rags-mcp-y99pg.29).
    if (!(params?.namedChildren ?? []).some((item) => item.type === "tuple_type_item")) continue;
    if (found !== undefined) return null;
    const types: (string | null)[] = [];
    for (const item of params?.namedChildren ?? []) {
      if (item.type !== "tuple_type_item") continue;
      const typeNode = item.namedChildren[item.namedChildCount - 1] ?? null;
      const written = typeNode?.type === "user_type" ? typeNode.text : undefined;
      if (written !== undefined && genericParameters.includes(written)) types.push(written);
      else {
        types.push(
          swiftSpelledWithArguments(
            swiftGenericResolvedFact(swiftTypeFactOf(typeNode), fn).nominal,
            typeNode,
            fn,
            genericParameters,
          ),
        );
      }
    }
    found = types;
  }
  return found;
}

/**
 * Whether `fn` returns exactly what its one value-taking closure returns: a
 * method generic `U` spelled as the declared return AND as that closure's
 * return — `func read<U>(_ closure: (Value) throws -> U) rethrows -> U` (bd
 * tea-rags-mcp-y99pg.37). Read positionally past `->`, for the materialization
 * hazard {@link swiftTypeNodeAfter} documents. A second function-typed
 * parameter, a wrapped `[U]` / `U?` return, or a closure taking nothing
 * disqualifies it.
 */
function swiftReturnsClosureResult(fn: AstNode): boolean {
  const generics = swiftTypeParameterNames(fn);
  if (generics.length === 0) return false;
  const returned = swiftTypeNodeAfter(fn, "->");
  if (returned?.type !== "user_type" || !generics.includes(returned.text.trim())) return false;
  let closure: AstNode | null = null;
  for (const parameter of fn.children) {
    if (parameter.type !== "parameter") continue;
    const functionType = swiftFunctionTypeNode(swiftParameterTypeNode(parameter));
    if (!functionType) continue;
    if (closure !== null) return false;
    closure = functionType;
  }
  if (closure === null) return false;
  const params = closure.children.find((c) => c.type === "tuple_type");
  if (!(params?.namedChildren ?? []).some((item) => item.type === "tuple_type_item")) return false;
  return swiftTypeNodeAfter(closure, "->")?.text.trim() === returned.text.trim();
}

/**
 * `nominal` spelled with the generic arguments `typeNode` states —
 * `Result<URLRequest, Error>` for `Result<URLRequest, any Error>` (bd
 * tea-rags-mcp-y99pg.32) — so a reader in another file can bind the
 * declaring SDK type's parameters (`Result.get()` returns `Success`). Each
 * argument is reduced to its nominal. The bare nominal when there are no
 * arguments, when one names nothing, or when one is a generic parameter in
 * scope: that is bound per use, not declared. Read positionally off
 * `type_arguments`, past an optional's `?`.
 */
function swiftSpelledWithArguments(
  nominal: string | null,
  typeNode: AstNode | null,
  at: AstNode,
  genericParameters: readonly string[],
): string | null {
  if (nominal === null) return null;
  let bare = typeNode;
  while (bare?.type === "optional_type") bare = bare.namedChildren[0] ?? null;
  if (bare?.type !== "user_type") return nominal;
  const args = bare.children.find((c) => c.type === "type_arguments")?.namedChildren ?? [];
  if (args.length === 0) return nominal;
  const names: string[] = [];
  for (const arg of args) {
    const name = swiftTypeFactOf(arg).nominal;
    if (name === null || genericParameters.includes(name) || swiftGenericConstraint(name, at) !== undefined) {
      return nominal;
    }
    names.push(name);
  }
  return `${nominal}<${names.join(", ")}>`;
}
