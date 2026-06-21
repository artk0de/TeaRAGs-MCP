import type { AstNode } from "../../../../contracts/types/ast.js";

/**
 * Find the class_body node within a class container. Works for both
 * `class_declaration` and `abstract_class_declaration` (bd tea-rags-mcp-olc2)
 * — both shapes nest a `class_body` child, so the lookup is type-agnostic.
 */
export function findClassBody(containerNode: AstNode): AstNode | null {
  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (child?.type === "class_body") return child;
  }
  return null;
}
