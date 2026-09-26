/**
 * TypeScript's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.4) — what
 * the kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: parameters (constructor parameter properties
 * included), `const` / `let` / `var` declarators and class fields — and each
 * function's return annotation as a `return` of the function itself (bd
 * tea-rags-mcp-4p3sb.21), read by the same annotation reader, an async
 * function's `Promise<T>` naming `T` (see `typescriptReturnTypeNode`).
 *
 * The binding-pattern reader and the `new X()` reading are ECMAScript, not
 * TypeScript, and JavaScript's syntax imports both from here. A destructuring
 * pattern binds each name as its own site, untyped: the annotation on
 * `{ a, b }: Opts` types the object, not `a`.
 *
 * An array or set annotation names its ELEMENT (`Job[]`, `Array<Job>`,
 * `ReadonlyArray<Job>`, `Set<Job>` → `Job`) — the lexicon groups `jobs` with
 * `Job`, as Go's slices and Java's arrays already do — and marks it `many`, so
 * `jobs: Job[]` and `job: Job` stay two roles (bd tea-rags-mcp-4p3sb.26). A rest
 * parameter is many through its own array annotation. `Promise<Job>` and maps
 * keep their head: a `docPromise` is not a `doc`. A local or field bound to a
 * call carries that call's callee, split the way the walker splits its
 * `CallRef`, `await` and a non-null `!` seen through.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  boundCalleeFromCallShape,
  elementOfCollection,
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { typescriptCallSiteShape } from "../walker.js";

/** Destructuring shapes whose bound names sit below the pattern node. */
function boundNameNodes(pattern: AstNode): AstNode[] {
  const names: AstNode[] = [];
  const stack: AstNode[] = [pattern];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    switch (node.type) {
      case "identifier":
      case "shorthand_property_identifier_pattern":
        names.push(node);
        break;
      case "pair_pattern": {
        const value = node.childForFieldName("value");
        if (value) stack.push(value);
        break;
      }
      case "assignment_pattern":
      case "object_assignment_pattern": {
        const left = node.childForFieldName("left");
        if (left) stack.push(left);
        break;
      }
      case "object_pattern":
      case "array_pattern":
      case "rest_pattern":
        for (let i = node.namedChildren.length - 1; i >= 0; i--) stack.push(node.namedChildren[i]);
        break;
      default:
        break;
    }
  }
  return names;
}

/**
 * The sites one ECMAScript binding target declares. A plain name (or `...name`)
 * keeps the annotation and initializer; a destructuring pattern yields one
 * untyped site per bound name.
 */
export function ecmascriptBindingSites(
  target: AstNode | null,
  kind: DeclaredIdentifierSite["kind"],
  typeNode: AstNode | null = null,
  valueNode: AstNode | null = null,
): DeclaredIdentifierSite[] {
  if (target === null) return [];
  const direct = target.type === "rest_pattern" ? target.namedChild(0) : target;
  if (direct?.type === "identifier") return [{ nameNode: direct, kind, typeNode, valueNode }];
  return boundNameNodes(target).map((nameNode) => ({ nameNode, kind }));
}

/** `new X()` / `new ns.X<T>()` → the constructor as written, type arguments excluded. */
export function ecmascriptConstructorTypeName(value: AstNode): string | undefined {
  if (value.type !== "new_expression") return undefined;
  const constructor = value.childForFieldName("constructor");
  return constructor?.type === "identifier" || constructor?.type === "member_expression" ? constructor.text : undefined;
}

/** `x => …` names its single parameter in the `parameter` field, not a parameter list. */
export const ECMASCRIPT_ARROW_PARAMETER_RULE: IdentifierDeclarationRule = {
  nodeType: "arrow_function",
  collect: (node) => ecmascriptBindingSites(node.childForFieldName("parameter"), "param"),
};

function parameterRule(nodeType: string): IdentifierDeclarationRule {
  return {
    nodeType,
    collect: (node) =>
      ecmascriptBindingSites(
        node.childForFieldName("pattern"),
        "param",
        node.childForFieldName("type"),
        node.childForFieldName("value"),
      ),
  };
}

/** `const x = …` / `let { a } = …` — TypeScript reads the `type` field, JavaScript has none. */
export const ECMASCRIPT_VARIABLE_DECLARATOR_RULE: IdentifierDeclarationRule = {
  nodeType: "variable_declarator",
  collect: (node) =>
    ecmascriptBindingSites(
      node.childForFieldName("name"),
      "local",
      node.childForFieldName("type"),
      node.childForFieldName("value"),
    ),
};

/** Generic heads whose annotation names its first type argument. */
const ELEMENT_NAMING_HEADS = new Set(["Array", "ReadonlyArray", "Set"]);

/**
 * Nominal annotations only: `Repo`, `ns.Repo`, `Repo<Doc>` → `Repo`, `string`;
 * `Job[]` / `readonly Job[]` / `Array<Job>` / `ReadonlyArray<Job>` / `Set<Job>`
 * → `Job`, many (bd tea-rags-mcp-4p3sb.26); unions, tuples, literals → none.
 * `readonly` alone collects nothing: `readonly Job[]` is many through its array.
 */
function typescriptAnnotationType(typeNode: AstNode): IdentifierSyntacticType | undefined {
  const inner = typeNode.type === "type_annotation" ? typeNode.namedChild(0) : typeNode;
  if (inner === null) return undefined;
  switch (inner.type) {
    case "type_identifier":
    case "nested_type_identifier":
    case "predefined_type":
      return { typeName: inner.text };
    case "array_type":
    case "readonly_type": {
      const element = inner.namedChild(0);
      const read = element === null ? undefined : typescriptAnnotationType(element);
      return elementOfCollection(read, inner.type === "array_type");
    }
    case "generic_type": {
      const head = inner.childForFieldName("name")?.text;
      if (head === undefined) return undefined;
      if (!ELEMENT_NAMING_HEADS.has(head)) return { typeName: head };
      // Positional: the argument list is the `type_arguments` child.
      const element = inner.namedChildren.find((child) => child.type === "type_arguments")?.namedChild(0) ?? null;
      return elementOfCollection(element === null ? undefined : typescriptAnnotationType(element), true);
    }
    default:
      return undefined;
  }
}

/** `new X()` read as a constructed type, never a collection — JavaScript reads it too. */
export function ecmascriptConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  const typeName = ecmascriptConstructorTypeName(value);
  return typeName === undefined ? undefined : { typeName };
}

/** The call an initializer IS: `await f()` and `f()!` are the call `f()`. */
export function ecmascriptOutermostCall(value: AstNode): AstNode {
  return value.type === "await_expression" || value.type === "non_null_expression"
    ? (value.namedChild(0) ?? value)
    : value;
}

function typescriptBoundCallee(value: AstNode): IdentifierBoundCallee | undefined {
  return boundCalleeFromCallShape(typescriptCallSiteShape(ecmascriptOutermostCall(value)));
}

/**
 * The annotation a function's return declaration is read from. An `async`
 * function's `Promise<T>` names `T`: the call-return join types `const doc =
 * await load()` through `load`'s return row and never sees the `await`, and
 * awaiting is what an async function's callers do. A non-async `Promise<T>`
 * keeps its head — returned as a value, it is a promise.
 */
function typescriptReturnTypeNode(fn: AstNode): AstNode | null {
  const annotation = fn.childForFieldName("return_type");
  if (annotation === null) return null;
  const inner = annotation.type === "type_annotation" ? annotation.namedChild(0) : annotation;
  const isAsync = fn.children.some((child) => child.type === "async");
  if (!isAsync || inner?.type !== "generic_type" || inner.childForFieldName("name")?.text !== "Promise") {
    return namesNoValue(inner) ? null : annotation;
  }
  // Positional: the argument list is the `type_arguments` child.
  const awaited = inner.namedChildren.find((child) => child.type === "type_arguments")?.namedChild(0) ?? null;
  return namesNoValue(awaited) ? null : awaited;
}

/** Returns nothing a local could hold: `void`, `never`, `undefined`. */
const VALUELESS_RETURN_TYPES = new Set(["void", "never", "undefined"]);

function namesNoValue(type: AstNode | null): boolean {
  return type?.type === "predefined_type" && VALUELESS_RETURN_TYPES.has(type.text);
}

/** A declaration that names itself: `function f(): T`, `m(): T`, `get(): T;` in an interface. */
function namedFunctionReturnRule(nodeType: string): IdentifierDeclarationRule {
  return {
    nodeType,
    collect: (node) => {
      const nameNode = node.childForFieldName("name");
      return nameNode === null ? [] : [{ nameNode, kind: "return", typeNode: typescriptReturnTypeNode(node) }];
    },
  };
}

/** Function VALUES — named by the declarator or class field that binds them. */
const FUNCTION_VALUE_TYPES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

/** `const f = (): T => …` / `load = async (): Promise<T> => …` — the binding names the function. */
function boundFunctionReturnRule(nodeType: string): IdentifierDeclarationRule {
  return {
    nodeType,
    collect: (node) => {
      const nameNode = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      if (nameNode === null || value === null || !FUNCTION_VALUE_TYPES.has(value.type)) return [];
      return [{ nameNode, kind: "return", typeNode: typescriptReturnTypeNode(value) }];
    },
  };
}

export const TYPESCRIPT_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    parameterRule("required_parameter"),
    parameterRule("optional_parameter"),
    ECMASCRIPT_ARROW_PARAMETER_RULE,
    ECMASCRIPT_VARIABLE_DECLARATOR_RULE,
    fieldRule("public_field_definition", "field", { name: "name", type: "type", value: "value" }),
    namedFunctionReturnRule("function_declaration"),
    namedFunctionReturnRule("generator_function_declaration"),
    namedFunctionReturnRule("function_signature"),
    namedFunctionReturnRule("method_definition"),
    namedFunctionReturnRule("method_signature"),
    namedFunctionReturnRule("abstract_method_signature"),
    boundFunctionReturnRule("variable_declarator"),
    boundFunctionReturnRule("public_field_definition"),
  ],
  annotationType: typescriptAnnotationType,
  constructorType: ecmascriptConstructorType,
  boundCalleeOf: typescriptBoundCallee,
};
