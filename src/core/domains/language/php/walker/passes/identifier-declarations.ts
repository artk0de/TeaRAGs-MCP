/**
 * PHP declarations the shared identifier pass can read.
 *
 *   - `property_declaration` holds the type; each `property_element` holds the
 *     `$name`. The `$` stays on the identifier text.
 *   - `simple_parameter` is a `param`. Promoted constructor properties and
 *     `foreach` bindings are not read.
 *   - `assignment_expression` whose left side is a bare `variable_name`, and
 *     whose enclosing callable is a method or function, is a `local`. The
 *     right-hand side is the value the shared pass types and binds.
 *   - `return_type` on a method or function is a `return`.
 *   - `const_element` is a class `constant`. Its `name` child is the bare
 *     identifier (`x`), unlike a variable's `$x`.
 *
 * `?Greeter` unwraps to `Greeter`. `void` and a union name nothing. `new
 * Greeter()` is a constructor type: `object_creation_expression` has no type
 * field, so the type is its first `name` or `qualified_name` child.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { IdentifierBoundCallee } from "../../../../../contracts/types/codegraph.js";
import {
  fieldRule,
  type DeclaredIdentifierSite,
  type IdentifierDeclarationSyntax,
  type IdentifierSyntacticType,
} from "../../../kernel/index.js";

function annotationType(node: AstNode): IdentifierSyntacticType | undefined {
  const inner = node.type === "optional_type" ? node.namedChildren[0] : node;
  if (!inner) return undefined;
  if (inner.type === "primitive_type") {
    if (inner.text === "void") return undefined;
    return { typeName: inner.text };
  }
  if (inner.type === "named_type") {
    const name = inner.namedChildren[0];
    return name ? { typeName: name.text } : undefined;
  }
  if (inner.type === "qualified_name" || inner.type === "name") return { typeName: inner.text };
  return undefined;
}

function constructorType(node: AstNode): IdentifierSyntacticType | undefined {
  if (node.type !== "object_creation_expression") return undefined;
  const name = node.namedChildren.find((child) => child.type === "name" || child.type === "qualified_name");
  return name ? { typeName: name.text } : undefined;
}

function boundCalleeOf(node: AstNode): IdentifierBoundCallee | undefined {
  if (node.type === "function_call_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type === "name") return { member: fn.text };
  }
  if (node.type === "member_call_expression" || node.type === "nullsafe_member_call_expression") {
    const name = node.childForFieldName("name");
    const object = node.childForFieldName("object");
    if (name?.type === "name" && object) return { receiver: object.text, member: name.text };
  }
  return undefined;
}

const propertyRule = {
  nodeType: "property_declaration",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const typeNode =
      node.childForFieldName("type") ??
      node.namedChildren.find(
        (child) => child.type === "primitive_type" || child.type === "named_type" || child.type === "optional_type",
      );
    return node.namedChildren
      .filter((child) => child.type === "property_element")
      .flatMap((element) => {
        const nameNode =
          element.childForFieldName("name") ?? element.namedChildren.find((child) => child.type === "variable_name");
        return nameNode ? [{ nameNode, kind: "field" as const, typeNode }] : [];
      });
  },
};

const assignmentRule = {
  nodeType: "assignment_expression",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const left = node.childForFieldName("left");
    if (left?.type !== "variable_name") return [];
    if (!insideCallable(node)) return [];
    return [{ nameNode: left, kind: "local", valueNode: node.childForFieldName("right") }];
  },
};

function insideCallable(node: AstNode): boolean {
  let cursor: AstNode | null = node.parent;
  while (cursor) {
    if (cursor.type === "method_declaration" || cursor.type === "function_definition") return true;
    if (
      cursor.type === "class_declaration" ||
      cursor.type === "interface_declaration" ||
      cursor.type === "trait_declaration"
    ) {
      return false;
    }
    cursor = cursor.parent;
  }
  return false;
}

const constantRule = {
  nodeType: "const_element",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.childForFieldName("name") ?? node.namedChildren.find((child) => child.type === "name");
    return nameNode && nameNode.text.length > 0 ? [{ nameNode, kind: "constant" }] : [];
  },
};

const returnRule = {
  nodeType: "method_declaration",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.childForFieldName("name");
    const typeNode = node.childForFieldName("return_type");
    return nameNode && typeNode ? [{ nameNode, kind: "return", typeNode }] : [];
  },
};

const functionReturnRule = {
  nodeType: "function_definition",
  collect: (node: AstNode): DeclaredIdentifierSite[] => {
    const nameNode = node.childForFieldName("name");
    const typeNode = node.childForFieldName("return_type");
    return nameNode && typeNode ? [{ nameNode, kind: "return", typeNode }] : [];
  },
};

export const PHP_IDENTIFIER_DECLARATION_SYNTAX: IdentifierDeclarationSyntax = {
  rules: [
    propertyRule,
    fieldRule("simple_parameter", "param", { name: "name", type: "type" }),
    assignmentRule,
    constantRule,
    returnRule,
    functionReturnRule,
  ],
  annotationType,
  constructorType,
  boundCalleeOf,
};
