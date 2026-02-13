import type Parser from "tree-sitter";

import type { ChunkingHook } from "../types.js";

/**
 * Scan lines backwards from a Ruby method node to collect preceding comment rows.
 * Allows up to 1 blank line between comment block and def.
 * Returns a Set of 0-based row numbers.
 */
export function collectMethodCommentRows(methodNode: Parser.SyntaxNode, codeLines: string[]): Set<number> {
  const rows = new Set<number>();
  const defRow = methodNode.startPosition.row;
  let row = defRow - 1;
  let blankCount = 0;

  // Skip up to 1 blank line between def and comment block
  while (row >= 0 && codeLines[row].trim().length === 0) {
    blankCount++;
    if (blankCount > 1) return rows; // 2+ blank lines → no comment capture
    row--;
  }

  // Collect consecutive comment lines going upward
  while (row >= 0) {
    const trimmed = codeLines[row].trim();
    if (trimmed.startsWith("#")) {
      rows.add(row);
      row--;
    } else {
      break;
    }
  }

  // Also include blank line(s) between comments and def if comments were found
  if (rows.size > 0 && blankCount > 0) {
    for (let br = defRow - 1; br >= defRow - blankCount; br--) {
      rows.add(br);
    }
  }

  return rows;
}

export const rubyCommentCaptureHook: ChunkingHook = {
  name: "rubyCommentCapture",
  process(ctx) {
    for (let i = 0; i < ctx.validChildren.length; i++) {
      const rows = collectMethodCommentRows(ctx.validChildren[i], ctx.codeLines);
      if (rows.size > 0) {
        for (const r of rows) ctx.excludedRows.add(r);
        const sorted = [...rows].sort((a, b) => a - b);
        ctx.methodPrefixes.set(i, sorted.map((r) => ctx.codeLines[r]).join("\n"));
        ctx.methodStartLines.set(i, sorted[0] + 1);
      }
    }
  },
};
