/**
 * Splits ONE oversized AST symbol (a method, function, class body the child
 * extraction could not break up) into parts that each fit the chunk budget —
 * without cutting inside a block that fits, and with each part carrying the
 * context it sits in instead of raw overlapping lines (bd tea-rags-mcp-y5vx4).
 *
 * Language-agnostic by construction: every multi-row descendant of the symbol
 * is a nesting span, so the cut rule of `NestingLineSplitter` lands between the
 * statements of the body first, then between the statements of an oversized
 * `if` / loop / closure / match arm, and so on down — whatever the grammar
 * calls those nodes. No per-language node list is consulted.
 *
 * Every part after the first is prefixed with its CONTEXT: the symbol's
 * signature rows plus the opening row of every construct still open where the
 * part starts (`if (cond) {`, `items.forEach((x) => {`, `} else {`). That
 * prefix is the only overlap between parts. A part's `startLine` / `endLine`
 * cover its own rows only — never the prefix — so a reader holding the parts
 * can drop the first `lines - (endLine - startLine + 1)` lines of every part
 * after the first and concatenate the rest back into the symbol body.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import { NestingLineSplitter, type NestingSpan } from "./nesting-line-splitter.js";

/** One part of a split symbol. Lines are 1-based, inclusive, prefix excluded. */
export interface AstSymbolPart {
  content: string;
  startLine: number;
  endLine: number;
}

/** A multi-row descendant, rows relative to the symbol's first row. */
interface SymbolSpan extends NestingSpan {
  /**
   * The construct OPENS on its first row — it begins with a keyword or
   * punctuation token (`if`, `for`, `{`, `do`, `func`), not with a complete
   * child. Only an opener's first row is context: a statement-list wrapper
   * (`statements`, `block`, `body_statement`) starts at its first statement,
   * and that statement says nothing about the rows below it.
   */
  readonly opener: boolean;
}

/** Signature rows kept in the context prefix: the first ones and the row opening the body. */
const MAX_SIGNATURE_ROWS = 4;

export class AstSymbolSplitter {
  /**
   * @param budget - characters one part may hold, context prefix included
   */
  constructor(private readonly budget: number) {}

  split(node: AstNode, code: string): AstSymbolPart[] {
    const firstRow = node.startPosition.row;
    const lastRow = AstSymbolSplitter.lastRowOf(node);
    const codeLines = code.split("\n");

    const rows: string[] = [];
    for (let row = firstRow; row <= lastRow; row++) {
      let text = codeLines[row] ?? "";
      if (row === lastRow && node.endPosition.row === lastRow) text = text.slice(0, node.endPosition.column);
      if (row === firstRow) text = text.slice(node.startPosition.column);
      rows.push(text);
    }

    const spans = this.collectSpans(node, firstRow, rows.length);
    const signatureRows = this.signatureRows(node, firstRow, rows);
    const contextLimit = Math.floor(this.budget / 3);
    const contextCache = new Map<number, string[]>();
    const contextAt = (row: number): string[] => {
      let cached = contextCache.get(row);
      if (cached === undefined) {
        cached = AstSymbolSplitter.fitContext(this.contextRows(row, spans, signatureRows), rows, contextLimit);
        contextCache.set(row, cached);
      }
      return cached;
    };
    const prefixLength = (row: number): number => {
      const lines = contextAt(row);
      return lines.length === 0 ? 0 : lines.reduce((sum, line) => sum + line.length + 1, 0);
    };

    const openingRows = new Set<number>(signatureRows);
    for (const span of spans) if (span.opener) openingRows.add(span.startRow);
    const splitter = new NestingLineSplitter({
      rows,
      spans,
      capacityAt: (row) => this.budget - prefixLength(row),
      openingRows,
    });

    return splitter.split().map((part) => {
      const body = part.columns
        ? rows[part.startRow].slice(part.columns.start, part.columns.end)
        : rows.slice(part.startRow, part.endRow + 1).join("\n");
      const context = contextAt(part.startRow);
      return {
        content: context.length === 0 ? body : `${context.join("\n")}\n${body}`,
        startLine: firstRow + part.startRow + 1,
        endLine: firstRow + part.endRow + 1,
      };
    });
  }

  /** Last row holding the node's text: a node ending at column 0 ends on the row above. */
  private static lastRowOf(node: AstNode): number {
    const { row, column } = node.endPosition;
    return column === 0 && row > node.startPosition.row ? row - 1 : row;
  }

  private collectSpans(node: AstNode, firstRow: number, rowCount: number): SymbolSpan[] {
    const spans: SymbolSpan[] = [];
    const visit = (n: AstNode): void => {
      for (const child of n.children) {
        const start = child.startPosition.row - firstRow;
        const end = Math.min(rowCount - 1, AstSymbolSplitter.lastRowOf(child) - firstRow);
        const opener = child.children.length === 0 || !child.children[0].isNamed;
        if (end > start) spans.push({ startRow: start, endRow: end, opener });
        visit(child);
      }
    };
    visit(node);
    return spans;
  }

  /**
   * Rows of the symbol's signature, relative: from its first row through the
   * row that opens its body (`{` / `:` / `do`), trimmed to the first rows plus
   * that opening row. A symbol without a `body` field keeps its first row.
   */
  private signatureRows(node: AstNode, firstRow: number, rows: string[]): number[] {
    const body = node.childForFieldName("body") ?? node.childForFieldName("definition")?.childForFieldName("body");
    if (!body) return [0];
    const bodyRow = body.startPosition.row - firstRow;
    const opensOnSignatureRow = (rows[bodyRow] ?? "").slice(0, body.startPosition.column).trim().length > 0;
    const lastSignatureRow = Math.max(0, opensOnSignatureRow ? bodyRow : bodyRow - 1);
    const signature: number[] = [];
    for (let row = 0; row <= lastSignatureRow; row++) {
      if (row < MAX_SIGNATURE_ROWS - 1 || row === lastSignatureRow) signature.push(row);
    }
    return signature;
  }

  /** Signature rows plus the opening row of every span still open at `row`, ascending, distinct. */
  private contextRows(row: number, spans: SymbolSpan[], signatureRows: number[]): number[] {
    if (row === 0) return [];
    const open = new Set<number>();
    for (const signatureRow of signatureRows) if (signatureRow < row) open.add(signatureRow);
    for (const span of spans) {
      if (span.opener && span.startRow < row && row <= span.endRow) open.add(span.startRow);
    }
    return [...open].sort((x, y) => x - y);
  }

  /**
   * Keep the context under `limit`: the symbol's first row always, then the
   * innermost opening rows that still fit — the enclosing block a part sits
   * in says more about it than an outer one.
   */
  private static fitContext(contextRows: number[], rows: string[], limit: number): string[] {
    if (contextRows.length === 0) return [];
    const lines = contextRows.map((row) => rows[row].trimEnd());
    const first = lines[0].slice(0, limit);
    let used = first.length + 1;
    const inner: string[] = [];
    for (let i = lines.length - 1; i >= 1; i--) {
      if (used + lines[i].length + 1 > limit) break;
      inner.unshift(lines[i]);
      used += lines[i].length + 1;
    }
    return [first, ...inner];
  }
}
