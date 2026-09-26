/**
 * Java's identifier-declaration syntax (bd tea-rags-mcp-4p3sb.6) — what the
 * kernel's `createIdentifierDeclarationFacetPass` reads to publish
 * `identifierDeclarations`: method, varargs, lambda and catch parameters,
 * local variables (enhanced-for and try-with-resources included) and fields —
 * and each method's declared return type, read by the same annotation reader.
 *
 * A local / field declaration holds one `variable_declarator` per name, all
 * sharing the declaration's `type`; the grammar repeats the `declarator` field,
 * which `childForFieldName` answers only once, so declarators are read as
 * children. `var` is no annotation — its name is typed by a `new X()`
 * initializer or joined at sink time.
 *
 * The annotation type drops generic arguments (`Map<K, V>` → `Map`), keeps a
 * qualified name as written (`com.acme.Panel`) and unwraps an array to its
 * element (`Widget[]` → `Widget`) — the lexicon groups `widgets` with
 * `Widget`, as Go's slices do. A collection or wrapper
 * (`List / Set / Collection / Iterable / Optional / Stream<T>`) names its
 * element the same way (bd tea-rags-mcp-4p3sb.17); a map keeps its head, an
 * unbounded `?` element gives no type. An array, a collection, a stream and a
 * varargs parameter mark the element `many`; `Optional` wraps one (bd
 * tea-rags-mcp-4p3sb.26). A local or field initialized by a method call
 * carries its callee, split the way the walker splits its `CallRef`; `new X()`
 * carries none, because the walker emits no `CallRef` for an object creation.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  boundCalleeFromCallShape,
  elementOfCollection,
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationRule,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { javaCallSiteShape } from "../walker.js";

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
    // `Item... more` is an `Item[]`, though its type node names only the element.
    return nameNode ? [{ nameNode, kind: "param", typeNode, typeMultiplicity: "many" }] : [];
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

/**
 * Generic heads whose annotation names its first type argument, matched on the
 * final segment (`java.util.List`): the collections and streams, which hold
 * MANY of it, and `Optional`, which wraps one.
 */
const COLLECTION_HEADS = new Set(["List", "Set", "Collection", "Iterable", "Stream"]);
const ELEMENT_NAMING_HEADS = new Set([...COLLECTION_HEADS, "Optional"]);

/** A generic's head as written: `Repo<Doc>` → `Repo`, `java.util.List<Doc>` → `java.util.List`. */
function javaGenericHeadName(generic: AstNode): string | undefined {
  const base = generic.namedChildren[0];
  return base ? javaAnnotationType(base)?.typeName : undefined;
}

/** The first type argument, read positionally; a bounded wildcard (`? extends Doc`) by its bound. */
function firstTypeArgument(generic: AstNode): AstNode | null {
  const args = generic.namedChildren.find((child) => child.type === "type_arguments");
  const first = args?.namedChildren[0] ?? null;
  return first?.type === "wildcard" ? (first.namedChildren.at(-1) ?? null) : first;
}

/**
 * `Repo` / `Map<K, V>` → `Map` / `com.acme.Panel` / `Widget[]` → `Widget` /
 * `int`; a collection or wrapper (`List<Doc>`, `Optional<Doc>`) → the element;
 * `var` and an unbounded `?` → none.
 */
function javaAnnotationType(node: AstNode): IdentifierSyntacticType | undefined {
  switch (node.type) {
    case "type_identifier":
      return node.text === "var" ? undefined : { typeName: node.text };
    case "scoped_type_identifier":
    case "integral_type":
    case "floating_point_type":
    case "boolean_type":
      return { typeName: node.text };
    case "generic_type": {
      const head = javaGenericHeadName(node);
      if (head === undefined) return undefined;
      const finalSegment = head.slice(head.lastIndexOf(".") + 1);
      if (!ELEMENT_NAMING_HEADS.has(finalSegment)) return { typeName: head };
      const element = firstTypeArgument(node);
      return elementOfCollection(element ? javaAnnotationType(element) : undefined, COLLECTION_HEADS.has(finalSegment));
    }
    case "array_type": {
      // The element is the first named child (then `dimensions`). Read by position,
      // not as the `element` field: the materialization guard surveys field names
      // across every grammar, and Swift's `array_type.element` is lost.
      const element = node.namedChildren[0];
      return elementOfCollection(element ? javaAnnotationType(element) : undefined, true);
    }
    default:
      return undefined;
  }
}

/**
 * `new Document(id)` / `new Repo<>()` / `new com.acme.Panel()` → the created
 * type, generic args dropped. The created class is named by its head even when
 * it is a collection: `new ArrayList<Doc>()` constructs an `ArrayList`.
 */
function javaConstructorType(value: AstNode): IdentifierSyntacticType | undefined {
  if (value.type !== "object_creation_expression") return undefined;
  const typeNode = value.childForFieldName("type");
  if (!typeNode) return undefined;
  if (typeNode.type !== "generic_type") return javaAnnotationType(typeNode);
  const head = javaGenericHeadName(typeNode);
  return head === undefined ? undefined : { typeName: head };
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
    // A method's declared return type, as a `return` of the method itself (bd
    // tea-rags-mcp-4p3sb.21); `void` reads as no type, so it declares nothing.
    fieldRule("method_declaration", "return", { name: "name", type: "type" }),
  ],
  annotationType: javaAnnotationType,
  constructorType: javaConstructorType,
  boundCalleeOf: (value) => boundCalleeFromCallShape(javaCallSiteShape(value)),
};
