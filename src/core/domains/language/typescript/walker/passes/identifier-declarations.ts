/**
 * TypeScript's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.4) — what
 * the kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: parameters (constructor parameter properties
 * included), `const` / `let` / `var` declarators and class fields.
 *
 * The binding-pattern reader and the `new X()` reading are ECMAScript, not
 * TypeScript, and JavaScript's syntax imports both from here. A destructuring
 * pattern binds each name as its own site, untyped: the annotation on
 * `{ a, b }: Opts` types the object, not `a`.
 *
 * An array or set annotation names its ELEMENT (`Job[]`, `Array<Job>`,
 * `ReadonlyArray<Job>`, `Set<Job>` → `Job`) — the lexicon groups `jobs` with
 * `Job`, as Go's slices and Java's arrays already do. `Promise<Job>` and maps
 * keep their head: a `docPromise` is not a `doc`. A local or field bound to a
 * call carries that call's callee, split the way the walker splits its
 * `CallRef`, `await` and a non-null `!` seen through.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  boundCalleeFromCallShape,
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";
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
 * → `Job`; unions, tuples, literals → none.
 */
function typescriptAnnotationTypeName(typeNode: AstNode): string | undefined {
  const inner = typeNode.type === "type_annotation" ? typeNode.namedChild(0) : typeNode;
  if (inner === null) return undefined;
  switch (inner.type) {
    case "type_identifier":
    case "nested_type_identifier":
    case "predefined_type":
      return inner.text;
    case "array_type":
    case "readonly_type": {
      const element = inner.namedChild(0);
      return element === null ? undefined : typescriptAnnotationTypeName(element);
    }
    case "generic_type": {
      const head = inner.childForFieldName("name")?.text;
      if (head === undefined || !ELEMENT_NAMING_HEADS.has(head)) return head;
      // Positional: the argument list is the `type_arguments` child.
      const element = inner.namedChildren.find((child) => child.type === "type_arguments")?.namedChild(0) ?? null;
      return element === null ? undefined : typescriptAnnotationTypeName(element);
    }
    default:
      return undefined;
  }
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

export const TYPESCRIPT_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    parameterRule("required_parameter"),
    parameterRule("optional_parameter"),
    ECMASCRIPT_ARROW_PARAMETER_RULE,
    ECMASCRIPT_VARIABLE_DECLARATOR_RULE,
    fieldRule("public_field_definition", "field", { name: "name", type: "type", value: "value" }),
  ],
  annotationTypeName: typescriptAnnotationTypeName,
  constructorTypeName: ecmascriptConstructorTypeName,
  boundCalleeOf: typescriptBoundCallee,
};
