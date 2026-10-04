/**
 * Cross-cluster primitives of the Swift walker: the positional type reads and
 * tree queries every cluster calls (`swiftTypeNodeAfter` is where the
 * materialization hazard's reasoning lives), the shared node-type sets, the
 * pattern-name and id-matching helpers, and the generic `walk`. Exports here
 * serve the sibling cluster modules and the entry facade; the walker's public
 * surface stays `walker.ts`.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { TypeDeclarationKind } from "../../../../contracts/types/codegraph.js";

/** `class` / `struct` / `enum` / `actor` / `extension` / `protocol`, or null for any other node. */
export function swiftTypeDeclarationKind(node: AstNode): TypeDeclarationKind | "extension" | null {
  if (node.type === "protocol_declaration") return "protocol";
  if (node.type !== "class_declaration") return null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child === null || child.isNamed) continue;
    if (child.type === "extension") return "extension";
    const keyword = SWIFT_TYPE_DECLARATION_KEYWORDS.get(child.type);
    if (keyword !== undefined) return keyword;
  }
  return null;
}

/**
 * The declaration keywords `class_declaration` covers. tree-sitter-swift gives
 * all four the same node type, so the keyword token is the only evidence of
 * which one a node is — and only `class` can have a superclass: a `struct` and
 * an `enum` conform to protocols, and Swift forbids an `actor` from inheriting
 * at all.
 */
export const SWIFT_TYPE_DECLARATION_KEYWORDS: ReadonlyMap<string, TypeDeclarationKind> = new Map(
  (["class", "struct", "enum", "actor"] as const).map((keyword) => [keyword, keyword]),
);

/** A declared or extended type's name with any generic argument list dropped (`Box<T>` → `Box`). */
export function swiftTypeNameText(text: string | undefined): string | undefined {
  const name = text?.split("<")[0]?.trim();
  return name !== undefined && name.length > 0 ? name : undefined;
}

/** Short name of the nearest enclosing nominal type, as `classFieldTypes` keys it. */
export function enclosingSwiftTypeName(node: AstNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") {
      return current.childForFieldName("name")?.text ?? null;
    }
  }
  return null;
}

/** A type declaration's nesting path: the enclosing types' names outward-in, then its own. */
export function swiftNestingPath(declaration: AstNode): string {
  const own = declaration.childForFieldName("name")?.text ?? "";
  const outer = enclosingSwiftTypePath(declaration);
  return outer === null ? own : `${outer}.${own}`;
}

/** The nesting path of the type declaration enclosing `node`, or null at file scope. */
export function enclosingSwiftTypePath(node: AstNode): string | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === "class_declaration" || current.type === "protocol_declaration") {
      return current.childForFieldName("name") ? swiftNestingPath(current) : null;
    }
  }
  return null;
}

/** Whether a composed id's final segment is `name`, an overload suffix aside. */
export function composedIdNames(symbolId: string, name: string): boolean {
  const base = symbolId.replace(OVERLOAD_SUFFIX, "");
  return base === name || base.endsWith(`#${name}`) || base.endsWith(`.${name}`);
}

/** The suffix `collectSymbols` appends to the 2nd and later declaration of one composed id. */
const OVERLOAD_SUFFIX = /~\d+$/;

/**
 * Declarations that own their own local names. Two bindings of one name in two
 * methods of the same type are different variables, so an identifier lookup is
 * confined to the bindings whose nearest such ancestor is the SAME node.
 *
 * `lambda_literal` is deliberately absent: a closure CAPTURES its enclosing
 * function's locals, so a `guard let` inside one must still see them.
 */
export const SWIFT_FUNCTION_LIKE_NODES: ReadonlySet<string> = new Set([
  "function_declaration",
  "protocol_function_declaration",
  "init_declaration",
  "deinit_declaration",
  "subscript_declaration",
  "computed_property",
]);

/**
 * The type node of a `parameter`, past any `type_modifiers` (`@escaping`,
 * `@Sendable`) — which tree-sitter-swift places between the `:` and the type.
 */
export function swiftParameterTypeNode(parameter: AstNode): AstNode | null {
  const at = parameter.children.findIndex((c) => c.type === ":");
  if (at === -1) return null;
  for (let i = at + 1; i < parameter.children.length; i++) {
    const child = parameter.children[i];
    // `@escaping` alone parses as `parameter_modifiers`, with `@Sendable` as `type_modifiers`.
    if (child.type !== "type_modifiers" && child.type !== "parameter_modifiers") return child;
  }
  return null;
}

/** A `function_type` node, looking through `?` and parentheses: `((T) -> Void)?`. */
export function swiftFunctionTypeNode(typeNode: AstNode | null): AstNode | null {
  if (!typeNode) return null;
  if (typeNode.type === "function_type") return typeNode;
  if (typeNode.type === "optional_type") return swiftFunctionTypeNode(typeNode.namedChildren[0] ?? null);
  if (typeNode.type === "tuple_type") return swiftFunctionTypeNode(parenthesizedSwiftTypeNode(typeNode));
  return null;
}

/** A declaration's own generic parameter names: `class Protected<Value>` → `["Value"]`. */
export function swiftTypeParameterNames(node: AstNode): string[] {
  const list = node.children.find((c) => c.type === "type_parameters");
  if (!list) return [];
  const names: string[] = [];
  for (const parameter of list.namedChildren) {
    if (parameter.type !== "type_parameter") continue;
    const identifier = parameter.namedChildren.find((c) => c.type === "type_identifier");
    if (identifier) names.push(identifier.text);
  }
  return names;
}

/** The `lambda_parameter` nodes a closure literal names, or null when it uses `$0`-style ones. */
export function swiftLambdaParameters(lambda: AstNode): AstNode[] | null {
  const signature = lambda.children.find((c) => c.type === "lambda_function_type");
  if (!signature) return null;
  const list = signature.children.find((c) => c.type === "lambda_function_type_parameters");
  return list ? list.children.filter((c) => c.type === "lambda_parameter") : [];
}

/** Receiver chains longer than this are not walked — a cap, not a semantic boundary. */
export const SWIFT_MAX_TYPE_HOPS = 4;

/** A spelled type name: UpperCamelCase, leading underscores allowed. */
export const SWIFT_TYPE_NAME_TEXT = /^_*[A-Z]/;

/**
 * The type a `tuple_type` merely PARENTHESISES, or null when it is a real
 * tuple.
 *
 * `(any EventMonitor)` and `(Thing)` parse as one-element tuples, a shape
 * Swift's type system does not have — `(T)` IS `T` — and the parentheses are
 * not optional in the one place this matters most, since `any P?` is ambiguous
 * and must be written `(any P)?`. Anything with a second item, or with a label
 * on its only item, is left alone: a member call dispatches on no tuple.
 *
 * Read positionally. `tuple_type_item.type` is one of the fields
 * tree-sitter-swift registers twice and `materializeTree` therefore drops, so a
 * field read here would work in a native-parsing spec and return nothing in
 * production — the hazard {@link swiftTypeNodeAfter} exists for.
 */
export function parenthesizedSwiftTypeNode(tupleType: AstNode): AstNode | null {
  if (tupleType.namedChildCount !== 1) return null;
  const item = tupleType.namedChildren[0];
  return item.type === "tuple_type_item" && item.namedChildCount === 1 ? item.namedChildren[0] : null;
}

/**
 * The type node that follows `separator` among a node's children — how EVERY
 * Swift type position is read here, and never `childForFieldName`.
 *
 * `materializeTree` rebuilds the field map from `fieldNameForChild`, which
 * reports ONE field name per child, and tree-sitter-swift registers every type
 * position under `name` as WELL as under `type` / `return_type`. `name` is what
 * gets reported, so on a MATERIALIZED node — the only kind the pipeline ever
 * walks, `CodegraphFileExtractor` materializes before calling a walker — both
 * `type` and `return_type` are simply absent. A field read therefore works in
 * every unit test (which parse natively) and silently returns nothing in
 * production, leaving `localBindings` and `classFieldTypes` empty for the whole
 * language.
 *
 * The position is unambiguous in each case a caller uses: `:` in a `parameter`,
 * `lambda_parameter` or `type_annotation`, `->` in a `func` signature. A
 * default value, a variadic `...` or a `throws` clause all sit on the far side
 * of the separator or beyond the type, so none of them displaces it.
 * `tests/…/swift-walker.test.ts` pins native-vs-materialized parity.
 */
export function swiftTypeNodeAfter(node: AstNode, separator: string): AstNode | null {
  const at = node.children.findIndex((c) => c.type === separator);
  return at === -1 ? null : (node.children[at + 1] ?? null);
}

/** A `pattern` node's identifier when it binds exactly one name; null for tuple / destructuring patterns. */
export function singleIdentifierPatternName(pattern: AstNode | null): string | null {
  if (pattern?.type !== "pattern" || pattern.namedChildCount !== 1) return null;
  const id = pattern.namedChildren[0];
  return id.type === "simple_identifier" ? id.text : null;
}

export function walk(node: AstNode, visit: (n: AstNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}
