import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";

/** Rust grammar nodes that represent source comments. */
const COMMENT_NODE_TYPES: ReadonlySet<string> = new Set(["line_comment", "block_comment", "comment"]);
const ATTRIBUTE_NODE_TYPE = "attribute_item";
const MAX_BLANK_LINE_GAP = 0;

/** Count blank source rows strictly between two 0-based rows. */
function blankRowsBetween(afterRow: number, beforeRow: number, codeLines: string[]): number {
  let blanks = 0;
  for (let row = afterRow + 1; row < beforeRow; row++) {
    if ((codeLines[row] ?? "").trim().length === 0) blanks++;
  }
  return blanks;
}

/**
 * Collect Rust comments belonging to an item, in source order.
 *
 * Rust attributes are sibling nodes between a comment and the item. Walk past
 * those attributes before collecting the comment run, but stop at another item
 * or at a comment separated by more than one blank source row.
 */
export function collectRustLeadingComments(itemNode: AstNode, codeLines: string[]): AstNode[] {
  const comments: AstNode[] = [];
  let anchorRow = itemNode.startPosition.row;
  let sibling = itemNode.previousNamedSibling;

  while (sibling) {
    if (sibling.type === ATTRIBUTE_NODE_TYPE) {
      if (blankRowsBetween(sibling.endPosition.row, anchorRow, codeLines) > MAX_BLANK_LINE_GAP) break;
      anchorRow = sibling.startPosition.row;
      sibling = sibling.previousNamedSibling;
      continue;
    }

    if (!COMMENT_NODE_TYPES.has(sibling.type)) break;
    if (blankRowsBetween(sibling.endPosition.row, anchorRow, codeLines) > MAX_BLANK_LINE_GAP) break;
    comments.unshift(sibling);
    anchorRow = sibling.startPosition.row;
    sibling = sibling.previousNamedSibling;
  }

  return comments;
}

/** Metadata hook: attach Rust item comments and exclude their rows from remainders. */
export const rustCommentCaptureHook: ChunkingHook = {
  name: "rustCommentCapture",
  process(ctx: HookContext): void {
    ctx.validChildren.forEach((item, index) => {
      const comments = collectRustLeadingComments(item, ctx.codeLines);
      if (comments.length === 0) return;

      for (const comment of comments) {
        for (let { row } = comment.startPosition; row <= comment.endPosition.row; row++) {
          ctx.excludedRows.add(row);
        }
      }

      ctx.methodPrefixes.set(index, comments.map((comment) => comment.text).join("\n"));
      ctx.methodStartLines.set(index, comments[0].startPosition.row + 1);
    });
  },
};
