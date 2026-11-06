/**
 * Kotlin parameters, locals, properties, and written return types.
 *
 * The grammar has no name or type fields on `parameter` / `class_parameter` /
 * `variable_declaration`. Names and types are positional named children.
 * `val` / `var` on a constructor parameter are anonymous keywords; a default
 * value whose text happens to contain those words is not a property.
 *
 * A `user_type` before the function name is an extension receiver
 * (`fun String.bold(): Widget`). The return type is the type after
 * `function_value_parameters`.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  boundCalleeFromCallShape,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";
import { kotlinCallSiteShape } from "../call-site.js";

const COLLECTION_HEADS = new Set([
  "List",
  "MutableList",
  "Set",
  "MutableSet",
  "Collection",
  "MutableCollection",
  "Iterable",
  "Sequence",
  "Array",
]);

function isPropertyParameter(node: AstNode): boolean {
  return node.children.some((child) => !child.isNamed && (child.type === "val" || child.type === "var"));
}

function parameterSite(node: AstNode, kind: DeclaredIdentifierSite["kind"]): DeclaredIdentifierSite[] {
  const nameNode = node.namedChildren.find((child) => child.type === "identifier");
  const typeNode = node.namedChildren.find((child) => child.type === "user_type" || child.type === "nullable_type");
  return nameNode ? [{ nameNode, kind, typeNode }] : [];
}

function propertyKind(node: AstNode): { kind: "local" | "field"; fileScope?: true } {
  for (let current = node.parent; current; current = current.parent) {
    if (
      current.type === "function_body" ||
      current.type === "lambda_literal" ||
      current.type === "anonymous_function"
    ) {
      return { kind: "local" };
    }
    if (
      current.type === "class_body" ||
      current.type === "enum_class_body" ||
      current.type === "companion_object" ||
      current.type === "class_declaration" ||
      current.type === "object_declaration"
    ) {
      return { kind: "field" };
    }
  }
  return { kind: "field", fileScope: true };
}

function returnTypeNode(node: AstNode): AstNode | undefined {
  const params = node.namedChildren.find((child) => child.type === "function_value_parameters");
  if (!params) return undefined;
  return node.namedChildren.find(
    (child) => child.startIndex > params.endIndex && (child.type === "user_type" || child.type === "nullable_type"),
  );
}

function dottedIdentifiers(node: AstNode): string | undefined {
  const ids = node.namedChildren.filter((child) => child.type === "identifier");
  if (ids.length === 0 || ids.some((id) => id.text.length === 0)) return undefined;
  return ids.map((id) => id.text).join(".");
}

function annotationType(node: AstNode): IdentifierSyntacticType | undefined {
  const inner = node.type === "nullable_type" ? (node.namedChildren[0] ?? node) : node;
  if (inner.type === "identifier") return inner.text.length > 0 ? { typeName: inner.text } : undefined;
  if (inner.type !== "user_type") return undefined;
  const head = dottedIdentifiers(inner);
  if (!head) return undefined;
  const typeArgs = inner.namedChildren.find((child) => child.type === "type_arguments");
  const simple = head.split(".").at(-1) ?? head;
  if (!typeArgs || !COLLECTION_HEADS.has(simple)) return { typeName: head };
  const projection = typeArgs.namedChildren[0];
  const elementNode =
    projection?.type === "type_projection" ? projection.namedChildren.find((child) => child.isNamed) : projection;
  const element = elementNode ? annotationType(elementNode) : undefined;
  return element ? { typeName: element.typeName, typeMultiplicity: "many" } : { typeName: head };
}

function constructorType(valueNode: AstNode): IdentifierSyntacticType | undefined {
  const shape = kotlinCallSiteShape(valueNode);
  if (!shape) return undefined;
  if (shape.receiver !== null || !/^[A-Z]/.test(shape.member)) return undefined;
  return { typeName: shape.member };
}

const parameterRule = {
  nodeType: "parameter",
  collect: (node: AstNode) => parameterSite(node, "param"),
};

const classParameterRule = {
  nodeType: "class_parameter",
  collect: (node: AstNode) => parameterSite(node, isPropertyParameter(node) ? "field" : "param"),
};

const propertyRule = {
  nodeType: "property_declaration",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const variable = node.namedChildren.find((child) => child.type === "variable_declaration");
    const nameNode = variable?.namedChildren.find((child) => child.type === "identifier");
    if (!nameNode) return [];
    const typeNode = variable?.namedChildren.find(
      (child) => child.type === "user_type" || child.type === "nullable_type",
    );
    const valueNode = node.namedChildren.find(
      (child) => variable !== undefined && child.startIndex > variable.endIndex,
    );
    const kind = propertyKind(node);
    return [
      { nameNode, kind: kind.kind, typeNode, valueNode, ...(kind.fileScope ? { fileScope: true as const } : {}) },
    ];
  },
};

const returnRule = {
  nodeType: "function_declaration",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.childForFieldName("name");
    const typeNode = returnTypeNode(node);
    return nameNode && typeNode && nameNode.text.length > 0 ? [{ nameNode, kind: "return", typeNode }] : [];
  },
};

export const KOTLIN_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [parameterRule, classParameterRule, propertyRule, returnRule],
  annotationType,
  constructorType,
  boundCalleeOf: (valueNode) => boundCalleeFromCallShape(kotlinCallSiteShape(valueNode)),
};
