/**
 * Java type-abstractness census (bd tea-rags-mcp-r8hme.8): an interface or an
 * `abstract` class is abstract. A type that declares behaviour of its own is
 * concrete; a type whose members are only constructors, fields and static
 * initializers declares no behaviour (bd tea-rags-mcp-44cpv, decision c-1=a:
 * an Exception subclass, a record over its components, an enum of constants;
 * an empty body is the degenerate case) and counts as neither. An annotation
 * type declares no behaviour and counts as neither too. The member-kind
 * boundary calls (lambda-valued field = behaviour, static data = data,
 * constructor = data, nested type = judged on its own) live with the kernel's
 * `isBehaviourFreeClassBody` doc.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  isBehaviourFreeClassBody,
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

function declaredAbstract(node: AstNode): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  return modifiers?.children.some((c) => c.type === "abstract") ?? false;
}

/** A function VALUE on a field: a lambda or a method reference (`Runnable r = () -> {}`). */
function isFunctionValuedDeclarator(node: AstNode): boolean {
  if (node.type !== "variable_declarator") return false;
  const value = node.childForFieldName("value");
  return value?.type === "lambda_expression" || value?.type === "method_reference";
}

/**
 * Whether one class-body member declares behaviour: a method, or a field whose
 * value is a function. Everything else — fields, constructors, static
 * initializers, enum constants, nested type declarations (judged on their own)
 * — is data or initialization.
 */
function classMemberDeclaresBehaviour(member: AstNode): boolean {
  switch (member.type) {
    case "method_declaration":
      return true;
    case "field_declaration":
      return member.namedChildren.some(isFunctionValuedDeclarator);
    default:
      return false;
  }
}

/** An enum body holds constants beside one `enum_body_declarations` node carrying the real members. */
function enumMemberDeclaresBehaviour(member: AstNode): boolean {
  if (member.type === "enum_body_declarations") return member.namedChildren.some(classMemberDeclaresBehaviour);
  return classMemberDeclaresBehaviour(member);
}

export const readJavaTypeAbstractness: TypeAbstractnessReader = (node) => {
  switch (node.type) {
    case "interface_declaration":
      return "abstract";
    case "class_declaration":
      if (declaredAbstract(node)) return "abstract";
      return isBehaviourFreeClassBody(node.childForFieldName("body"), classMemberDeclaresBehaviour) ? null : "concrete";
    case "enum_declaration":
      return isBehaviourFreeClassBody(node.childForFieldName("body"), enumMemberDeclaresBehaviour) ? null : "concrete";
    case "record_declaration":
      return isBehaviourFreeClassBody(node.childForFieldName("body"), classMemberDeclaresBehaviour) ? null : "concrete";
    default:
      return null;
  }
};

export const javaTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass(readJavaTypeAbstractness);
