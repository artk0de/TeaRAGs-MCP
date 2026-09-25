/**
 * Java type-abstractness census (bd tea-rags-mcp-r8hme.8): an interface or an
 * `abstract` class is abstract; any other class, an enum and a record are
 * concrete; an annotation type declares no behaviour and counts as neither.
 */

import type { AstNode } from "../../../../../contracts/types/ast.js";
import {
  typeAbstractnessFacetPass,
  type ExtractionFacetPass,
  type TypeAbstractnessReader,
} from "../../../kernel/index.js";

function declaredAbstract(node: AstNode): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  return modifiers?.children.some((c) => c.type === "abstract") ?? false;
}

export const readJavaTypeAbstractness: TypeAbstractnessReader = (node) => {
  switch (node.type) {
    case "interface_declaration":
      return "abstract";
    case "class_declaration":
      return declaredAbstract(node) ? "abstract" : "concrete";
    case "enum_declaration":
    case "record_declaration":
      return "concrete";
    default:
      return null;
  }
};

export const javaTypeAbstractnessFacetPass: ExtractionFacetPass = typeAbstractnessFacetPass(readJavaTypeAbstractness);
