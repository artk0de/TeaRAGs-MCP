/**
 * Java's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.6) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: method, varargs, lambda and catch parameters,
 * local variables (enhanced-for and try-with-resources included) and fields.
 *
 * A local / field declaration holds one `variable_declarator` per name, all
 * sharing the declaration's `type`; the grammar repeats the `declarator` field,
 * which `childForFieldName` answers only once, so declarators are read as
 * children. `var` is no annotation — its name is typed by a `new X()`
 * initializer or joined at sink time.
 *
 * The annotation type drops generic arguments (`List<Doc>` → `List`), keeps a
 * qualified name as written (`com.acme.Panel`) and unwraps an array to its
 * element (`Widget[]` → `Widget`) — the lexicon groups `widgets` with
 * `Widget`, as Go's slices do.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
} from "../../../kernel/identifier-declarations.js";

/** `T a = …, b;` — one site per `variable_declarator`, typed by the shared declaration type. */
function declaratorRule(nodeType: string, kind: DeclaredIdentifierSite["kind"]): IdentifierDeclarationRule {
  return {
    nodeType,
    collect: (node) => {
      const typeNode = node.childForFieldName("type");
      return node.namedChildren
        .filter((child) => child.type === "variable_declarator")
        .flatMap((declarator) => {
          const nameNode = declarator.childForFieldName("name");
          return nameNode ? [{ nameNode, kind, typeNode, valueNode: declarator.childForFieldName("value") }] : [];
        });
    },
  };
}

/** `Item... more` — the element type is the first named child, the name sits in a nested declarator. */
const spreadParameterRule: IdentifierDeclarationRule = {
  nodeType: "spread_parameter",
  collect: (node) => {
    const declarator = node.namedChildren.find((child) => child.type === "variable_declarator");
    const nameNode = declarator?.childForFieldName("name");
    const typeNode = node.namedChildren.find((child) => child.type !== "modifiers") ?? null;
    return nameNode ? [{ nameNode, kind: "param", typeNode }] : [];
  },
};

/** `x -> …` / `(x, y) -> …` — inferred lambda parameters; a typed list is `formal_parameter`s. */
const lambdaParameterRule: IdentifierDeclarationRule = {
  nodeType: "lambda_expression",
  collect: (node) => {
    const params = node.childForFieldName("parameters");
    if (params?.type === "identifier") return [{ nameNode: params, kind: "param" }];
    if (params?.type !== "inferred_parameters") return [];
    return params.namedChildren
      .filter((child) => child.type === "identifier")
      .map((nameNode) => ({ nameNode, kind: "param" as const }));
  },
};

/** `catch (IOException e)` — typed only when a single exception type is caught. */
const catchParameterRule: IdentifierDeclarationRule = {
  nodeType: "catch_formal_parameter",
  collect: (node) => {
    const nameNode = node.childForFieldName("name");
    const catchType = node.namedChildren.find((child) => child.type === "catch_type");
    const typeNode = catchType?.namedChildCount === 1 ? catchType.namedChildren[0] : null;
    return nameNode ? [{ nameNode, kind: "local", typeNode }] : [];
  },
};

/** `Repo` / `List<Doc>` → `List` / `com.acme.Panel` / `Widget[]` → `Widget` / `int`; `var` → none. */
function javaAnnotationTypeName(node: AstNode): string | undefined {
  switch (node.type) {
    case "type_identifier":
      return node.text === "var" ? undefined : node.text;
    case "scoped_type_identifier":
    case "integral_type":
    case "floating_point_type":
    case "boolean_type":
      return node.text;
    case "generic_type": {
      const base = node.namedChildren[0];
      return base ? javaAnnotationTypeName(base) : undefined;
    }
    case "array_type": {
      // The element is the first named child (then `dimensions`). Read by position,
      // not as the `element` field: the materialization guard surveys field names
      // across every grammar, and Swift's `array_type.element` is lost.
      const element = node.namedChildren[0];
      return element ? javaAnnotationTypeName(element) : undefined;
    }
    default:
      return undefined;
  }
}

/** `new Document(id)` / `new Repo<>()` / `new com.acme.Panel()` → the created type, generic args dropped. */
function javaConstructorTypeName(value: AstNode): string | undefined {
  if (value.type !== "object_creation_expression") return undefined;
  const typeNode = value.childForFieldName("type");
  return typeNode ? javaAnnotationTypeName(typeNode) : undefined;
}

export const JAVA_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    declaratorRule("field_declaration", "field"),
    fieldRule("formal_parameter", "param", { name: "name", type: "type" }),
    spreadParameterRule,
    declaratorRule("local_variable_declaration", "local"),
    lambdaParameterRule,
    fieldRule("enhanced_for_statement", "local", { name: "name", type: "type" }),
    fieldRule("resource", "local", { name: "name", type: "type", value: "value" }),
    catchParameterRule,
  ],
  annotationTypeName: javaAnnotationTypeName,
  constructorTypeName: javaConstructorTypeName,
};
