import type Parser from "tree-sitter";

/**
 * Find the class_body node within a class_declaration container.
 */
export function findClassBody(containerNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (child?.type === "class_body") return child;
  }
  return null;
}
