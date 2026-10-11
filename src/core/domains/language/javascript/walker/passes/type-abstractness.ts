/**
 * JavaScript type-abstractness census (bd tea-rags-mcp-r8hme.8). JavaScript
 * has no way to declare behaviour without implementing it, so nothing is
 * abstract. A class that declares behaviour of its own — a method, a static
 * method, a function-valued property — is concrete; a class whose members are
 * only a constructor, property fields and accessors declares no behaviour (bd
 * tea-rags-mcp-44cpv, decision c-1=a: an Error subclass, a data-only shape; an
 * empty class is the degenerate case) and counts as neither, like a class
 * expression, which is a value, not a declaration. The member-kind boundary
 * calls live with the kernel's `isBehaviourFreeClassBody` doc.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  isBehaviourFreeClassBody,
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

/** A function VALUE on a class property: an arrow or a function expression (`handler = async () => {}`). */
function isFunctionValuedProperty(node: AstNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression";
}

/**
 * Whether one class-body member declares behaviour: a method that is neither
 * the constructor nor an accessor, or a property holding a function value.
 * Everything else — fields, getters/setters, a `static { … }` block — is data
 * or initialization.
 */
function classMemberDeclaresBehaviour(member: AstNode): boolean {
  switch (member.type) {
    case "method_definition":
      if (member.childForFieldName("name")?.text === "constructor") return false;
      return !member.children.some((child) => child.type === "get" || child.type === "set");
    case "field_definition":
      return isFunctionValuedProperty(member.childForFieldName("value"));
    default:
      return false;
  }
}

const readJavascriptTypeAbstractness: TypeAbstractnessReader = (node) => {
  if (node.type !== "class_declaration") return null;
  return isBehaviourFreeClassBody(node.childForFieldName("body"), classMemberDeclaresBehaviour) ? null : "concrete";
};

export const javascriptTypeAbstractnessFacetPass: ExtractionFacetPass =
  typeAbstractnessFacetPass(readJavascriptTypeAbstractness);
