// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * CharacterChunker — chunking for text without an AST (sql, json, jsonc, plain
 * text, a parse that yielded nothing). Used as the fallback when AST parsing is
 * not available.
 *
 * Cuts only at syntax-neutral boundaries (bd tea-rags-mcp-y5vx4): a blank line
 * first, then the end of a top-level statement (`;` outside brackets) or a
 * top-level entry, and never inside a bracket pair or a line that fits a chunk.
 * Those preferences are expressed as nesting spans for `NestingLineSplitter` —
 * bracket pairs, paragraphs (runs of non-blank lines) and `;`-terminated
 * statements — so the same cut rule as the AST path applies. Only a single
 * line wider than the budget is cut by characters.
 *
 * Overlap is whole top-level units of the previous chunk, up to `chunkOverlap`
 * characters: a chunk opens on the same kind of boundary it was cut on.
 */

import type { ChunkerConfig, CodeChunk } from "../../../../types.js";
import type { CodeChunker } from "./base.js";
import { NestingLineSplitter, type NestingSpan } from "./nesting-line-splitter.js";

/** A chunk whose trimmed text is this short carries no search value on its own. */
const MIN_CHUNK_CHARS = 50;

const OPENING_BRACKETS = new Map([
  ["{", "}"],
  ["[", "]"],
  ["(", ")"],
]);
const CLOSING_BRACKETS = new Set(["}", "]", ")"]);

interface RowRange {
  startRow: number;
  endRow: number;
}

export class CharacterChunker implements CodeChunker {
  constructor(private readonly config: ChunkerConfig) {}

  async chunk(code: string, filePath: string, language: string): Promise<CodeChunk[]> {
    const rows = code.split("\n");
    // The hard cap is the budget (the pipeline sets maxChunkSize = chunkSize).
    const budget = this.config.maxChunkSize;
    const overlapLimit = Math.max(0, Math.min(this.config.chunkOverlap, Math.floor(budget / 4)));

    const splitter = new NestingLineSplitter({
      rows,
      spans: syntaxNeutralSpans(rows),
      capacityAt: (row) => (row === 0 ? budget : budget - overlapLimit),
    });

    const cuts = splitter.split();
    const ranges: RowRange[] = [];
    const sliced = new Map<RowRange, { start: number; end: number }>();
    cuts.forEach((cut, i) => {
      const range = { startRow: cut.startRow, endRow: cut.endRow };
      if (cut.columns) sliced.set(range, cut.columns);
      else if (i > 0 && !cuts[i - 1].columns) {
        range.startRow = this.overlapStart(splitter, rows, cuts[i - 1], cut.startRow, overlapLimit);
      }
      ranges.push(range);
    });

    const chunks: CodeChunk[] = [];
    for (const range of this.absorbTinyRanges(ranges, rows, sliced)) {
      const columns = sliced.get(range);
      const trimmed = columns ? range : trimBlankRows(range, rows);
      if (!trimmed) continue;
      const content = columns
        ? rows[range.startRow].slice(columns.start, columns.end)
        : rows.slice(trimmed.startRow, trimmed.endRow + 1).join("\n");
      if (content.trim().length === 0) continue;
      chunks.push({
        content,
        startLine: trimmed.startRow + 1,
        endLine: trimmed.endRow + 1,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: "block",
        },
      });
    }
    // A lone chunk this small is noise (a stray token, a trailing brace).
    if (chunks.length === 1 && chunks[0].content.trim().length <= MIN_CHUNK_CHARS) return [];
    return chunks;
  }

  supportsLanguage(_language: string): boolean {
    // Character chunker supports all languages
    return true;
  }

  getStrategyName(): string {
    return "character-based";
  }

  /**
   * Where the chunk starting at `startRow` really starts once the overlap is
   * added: the earliest row of the previous chunk that begins a unit at least
   * as shallow as the cut between the two chunks, with everything from it up
   * to the cut fitting in `limit` characters. No such row → no overlap.
   */
  private overlapStart(
    splitter: NestingLineSplitter,
    rows: string[],
    previous: RowRange,
    startRow: number,
    limit: number,
  ): number {
    if (limit === 0) return startRow;
    const boundaryDepth = splitter.cutDepthAfter(startRow - 1);
    let best = startRow;
    for (let row = startRow - 1; row > previous.startRow; row--) {
      if (splitter.sizeOf(row, startRow - 1) > limit) break;
      if (splitter.cutDepthAfter(row - 1) <= boundaryDepth && rows[row].trim() !== "") best = row;
    }
    return best;
  }

  /**
   * Fold a range whose text is below `MIN_CHUNK_CHARS` into a neighbour when
   * the result still fits the hard cap, so a trailing brace or a one-word line
   * does not become a chunk of its own.
   */
  private absorbTinyRanges(
    ranges: RowRange[],
    rows: string[],
    sliced: Map<RowRange, { start: number; end: number }>,
  ): RowRange[] {
    const size = (r: RowRange) => rows.slice(r.startRow, r.endRow + 1).join("\n").length;
    const result: RowRange[] = [];
    for (const range of ranges) {
      const previous = result[result.length - 1];
      const tiny =
        rows
          .slice(range.startRow, range.endRow + 1)
          .join("\n")
          .trim().length <= MIN_CHUNK_CHARS;
      if (
        tiny &&
        previous &&
        !sliced.has(range) &&
        !sliced.has(previous) &&
        size({ startRow: previous.startRow, endRow: range.endRow }) <= this.config.maxChunkSize
      ) {
        previous.endRow = Math.max(previous.endRow, range.endRow);
        continue;
      }
      result.push(range);
    }
    return result;
  }
}

/** The range without leading and trailing blank rows; undefined when nothing is left. */
function trimBlankRows(range: RowRange, rows: string[]): RowRange | undefined {
  let { startRow, endRow } = range;
  while (startRow <= endRow && rows[startRow].trim() === "") startRow++;
  while (endRow >= startRow && rows[endRow].trim() === "") endRow--;
  return startRow <= endRow ? { startRow, endRow } : undefined;
}

/**
 * Nesting spans a syntax-blind reader can still trust: multi-row bracket pairs
 * (quote-aware per row, template backticks across rows), paragraphs — runs of
 * non-blank rows — and statements ending in `;` outside any bracket.
 */
export function syntaxNeutralSpans(rows: readonly string[]): NestingSpan[] {
  const spans: NestingSpan[] = [];
  const open: { closer: string; row: number }[] = [];
  let inBacktick = false;
  let statementStart = -1;
  let paragraphStart = -1;

  rows.forEach((text, row) => {
    const blank = text.trim() === "";
    if (blank) {
      if (paragraphStart >= 0 && row - 1 > paragraphStart) spans.push({ startRow: paragraphStart, endRow: row - 1 });
      paragraphStart = -1;
    } else if (paragraphStart < 0) {
      paragraphStart = row;
    }

    if (!blank && statementStart < 0 && open.length === 0 && !inBacktick) statementStart = row;

    let quote: string | undefined;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inBacktick) {
        if (ch === "\\") i++;
        else if (ch === "`") inBacktick = false;
        continue;
      }
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = undefined;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "`") inBacktick = true;
      else if (OPENING_BRACKETS.has(ch)) open.push({ closer: OPENING_BRACKETS.get(ch) ?? "", row });
      else if (CLOSING_BRACKETS.has(ch)) {
        const index = findLastIndex(open, (o) => o.closer === ch);
        if (index < 0) continue;
        const [pair] = open.splice(index);
        if (row > pair.row) spans.push({ startRow: pair.row, endRow: row });
      }
    }

    if (open.length === 0 && !inBacktick && text.trimEnd().endsWith(";")) {
      if (statementStart >= 0 && row > statementStart) spans.push({ startRow: statementStart, endRow: row });
      statementStart = -1;
    }
  });
  if (paragraphStart >= 0 && rows.length - 1 > paragraphStart) {
    spans.push({ startRow: paragraphStart, endRow: rows.length - 1 });
  }
  return spans;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (predicate(items[i])) return i;
  return -1;
}
