/**
 * TypeScript Comment Capture Hook — AST-based.
 *
 * Uses tree-sitter AST to find comment nodes preceding methods.
 * Unlike Ruby's text-scanning approach, walks previousNamedSibling
 * from each method_definition in the class_body.
 */
import type Parser from "tree-sitter";

import type { ChunkingHook } from "../types.js";

/**
 * Find the class_body node within a class_declaration container.
 */
function findClassBody(containerNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (child?.type === "class_body") return child;
  }
  return null;
}

/**
 * Find the class_body child node matching a method node by row position.
 */
function findMethodInClassBody(classBody: Parser.SyntaxNode, methodNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
  for (let i = 0; i < classBody.namedChildCount; i++) {
    const child = classBody.namedChild(i);
    if (child?.type === "method_definition" && child.startPosition.row === methodNode.startPosition.row) {
      return child;
    }
  }
  return null;
}

/**
 * Collect comment nodes preceding a method in class_body AST.
 * Walks previousNamedSibling while type === "comment".
 * Returns comments in source order (top to bottom).
 */
function collectPrecedingComments(methodInBody: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const comments: Parser.SyntaxNode[] = [];
  let sibling = methodInBody.previousNamedSibling;
  while (sibling?.type === "comment") {
    comments.unshift(sibling);
    sibling = sibling.previousNamedSibling;
  }
  return comments;
}

export const typescriptCommentCaptureHook: ChunkingHook = {
  name: "typescriptCommentCapture",
  process(ctx) {
    const classBody = findClassBody(ctx.containerNode);
    if (!classBody) return;

    for (let i = 0; i < ctx.validChildren.length; i++) {
      const methodNode = ctx.validChildren[i];
      const methodInBody = findMethodInClassBody(classBody, methodNode);
      if (!methodInBody) continue;

      const comments = collectPrecedingComments(methodInBody);
      if (comments.length === 0) continue;

      // Mark comment rows as excluded from body chunks
      for (const comment of comments) {
        for (let { row } = comment.startPosition; row <= comment.endPosition.row; row++) {
          ctx.excludedRows.add(row);
        }
      }

      // Build prefix text
      const prefixText = comments.map((c) => c.text).join("\n");
      ctx.methodPrefixes.set(i, prefixText);
      ctx.methodStartLines.set(i, comments[0].startPosition.row + 1); // 1-based
    }
  },
};
