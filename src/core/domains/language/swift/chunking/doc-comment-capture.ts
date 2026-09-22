/**
 * Swift doc-comment capture — attaches a declaration's documentation to the
 * chunk that declaration produces.
 *
 * The generic engine slices a chunk as `code.substring(node.startIndex,
 * node.endIndex)`, and a Swift doc comment is a preceding SIBLING of the
 * declaration, never a child. Without a capture hook the documentation falls
 * outside every method chunk and is orphaned into the enclosing type chunk —
 * measured on this grammar before this module existed. TypeScript
 * (`typescript/chunking/comment-capture.ts`) and Ruby
 * (`ruby/chunking/comment-capture.ts`) each solve it the same way, through
 * `ctx.methodPrefixes` / `ctx.methodStartLines` / `ctx.excludedRows`; this is
 * the Swift port.
 *
 * Two Swift specifics the other two ports do not have:
 *
 *   - a block doc comment parses as `multiline_comment`, a DIFFERENT node type
 *     from the `comment` that covers `//` and `///`. A TypeScript-style
 *     `type === "comment"` walk silently drops every block doc comment.
 *   - `// MARK:` is a section divider Xcode renders in the jump bar, not
 *     documentation of the declaration under it. It terminates the walk and is
 *     not captured: attaching "MARK: - Private helpers" to whichever member
 *     happens to follow labels that member with the SECTION's name, and
 *     crossing it would pull the previous section's trailing comments in.
 *     Swift's own doc tooling agrees — DocC reads `///` and block doc
 *     comments, never `// MARK:`.
 *
 * Scope is member declarations, matching TypeScript and Ruby exactly. A
 * TOP-LEVEL `func`'s doc comment is still dropped, because such a node is
 * emitted by `chunkSingleNode`, which consults no hook context — the same
 * limitation TypeScript has for a top-level `function` with a JSDoc block.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { ChunkingHook, HookContext } from "../../../../contracts/types/chunker.js";

/** Both comment node types tree-sitter-swift emits: line comments, and block comments. */
const COMMENT_NODE_TYPES: ReadonlySet<string> = new Set(["comment", "multiline_comment"]);

/** Xcode section marker — a divider between member groups, not documentation. */
const SECTION_MARKER = /^\/\/\s*MARK:/;

/**
 * Blank lines tolerated between a comment block and what it documents. One
 * matches Ruby's `collectMethodCommentRows`; two or more means the comment
 * floats free (a file banner, a note about the type) and belongs to nobody.
 */
const MAX_BLANK_LINE_GAP = 1;

/**
 * Comment nodes documenting `memberNode`, in source order.
 *
 * Walks `previousNamedSibling` — the materialized tree populates it, and
 * sibling order ignores whitespace, so a `///` run collects as the consecutive
 * `comment` nodes it is. The blank-line gap is measured against source rows
 * because the AST cannot see it.
 */
export function collectSwiftDocComments(memberNode: AstNode, codeLines: string[]): AstNode[] {
  const comments: AstNode[] = [];
  let anchorRow = memberNode.startPosition.row;
  let sibling = memberNode.previousNamedSibling;

  while (sibling && COMMENT_NODE_TYPES.has(sibling.type)) {
    if (SECTION_MARKER.test(sibling.text.trimStart())) break;
    if (blankRowsBetween(sibling.endPosition.row, anchorRow, codeLines) > MAX_BLANK_LINE_GAP) break;
    comments.unshift(sibling);
    anchorRow = sibling.startPosition.row;
    sibling = sibling.previousNamedSibling;
  }

  return comments;
}

/** Count blank source rows strictly between two 0-based rows. */
function blankRowsBetween(afterRow: number, beforeRow: number, codeLines: string[]): number {
  let blanks = 0;
  for (let row = afterRow + 1; row < beforeRow; row++) {
    if ((codeLines[row] ?? "").trim().length === 0) blanks++;
  }
  return blanks;
}

/**
 * Metadata hook (chain position 2). Writes the prefix and the backed-up start
 * line the engine's `emitLeafChild` reads, and marks the comment rows excluded
 * so the container-body chunker does not emit them a second time. It must NOT
 * touch `ctx.bodyChunks`.
 */
export const swiftDocCommentCaptureHook: ChunkingHook = {
  name: "swiftDocCommentCapture",
  process(ctx: HookContext): void {
    ctx.validChildren.forEach((member, index) => {
      const comments = collectSwiftDocComments(member, ctx.codeLines);
      if (comments.length === 0) return;

      for (const comment of comments) {
        for (let { row } = comment.startPosition; row <= comment.endPosition.row; row++) {
          ctx.excludedRows.add(row);
        }
      }

      ctx.methodPrefixes.set(index, comments.map((c) => c.text).join("\n"));
      ctx.methodStartLines.set(index, comments[0].startPosition.row + 1);
    });
  },
};
