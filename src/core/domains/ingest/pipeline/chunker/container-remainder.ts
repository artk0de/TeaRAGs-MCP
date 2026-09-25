/**
 * Container remainder planning (bd tea-rags-mcp-deoki).
 *
 * When the engine extracts a container's children into their own chunks, the
 * container's OWN rows — its header, the statements around a nested `def`, a
 * class attribute declared between two methods, the factory code around a
 * returned object literal — belong to no child. This module decides which of
 * those rows make up the container's remainder chunk and how that chunk is
 * cut when it is oversized. It is pure: rows in, parts out. Identity (symbolId,
 * chunkType, parent fields) is the engine's business, not this planner's.
 */

/** 1-based, inclusive source range of one contiguous run of remainder rows. */
export interface ContainerRemainderRange {
  start: number;
  end: number;
}

/** One emitted remainder chunk (the whole remainder, or one `#partN` window). */
export interface ContainerRemainderPart {
  content: string;
  /** 1-based first remainder row of this part. */
  startLine: number;
  /** 1-based last remainder row of this part. */
  endLine: number;
  /** The part's runs — more than one when a child sits between them. */
  lineRanges: ContainerRemainderRange[];
}

export interface ContainerRemainderInput {
  codeLines: readonly string[];
  /** 0-based rows of the container node, inclusive. */
  containerStartRow: number;
  containerEndRow: number;
  /** 0-based rows some other chunk already carries (children, body chunks, captured comments). */
  coveredRows: ReadonlySet<number>;
  /** The container's first row, trimmed — prefixed only when that row is itself covered. */
  containerHeader: string;
  /** Enclosing containers' headers, already rendered (empty for a top-level container). */
  hierarchyPrefix: string;
  maxChunkSize: number;
  /** The engine's noise floor, measured on the remainder's substantive rows only. */
  minContentLength: number;
}

/**
 * A row with nothing but closing punctuation (`}`, `});`, `)`, Ruby `end`).
 * Such rows are carried in the remainder so every row of the container lands
 * in some chunk, but they never count toward the noise floor — otherwise a
 * long class header plus its closing brace would emit a chunk with no code.
 */
const PUNCTUATION_ONLY_ROW = /^[\s{}()[\];,]*$|^\s*end\s*$/;

/** Remainder rows grouped into runs: consecutive rows, or rows separated only by blank rows. */
function collectRuns(input: ContainerRemainderInput): number[][] {
  const { codeLines, containerStartRow, containerEndRow, coveredRows } = input;
  const runs: number[][] = [];
  let current: number[] = [];
  for (let row = containerStartRow; row <= containerEndRow; row++) {
    if (coveredRows.has(row)) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    if ((codeLines[row] ?? "").trim() === "") continue;
    current.push(row);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/**
 * Plan the remainder chunk(s) of one container. Returns `[]` when the
 * remainder is empty, is only the header line, or is below the noise floor;
 * one part when it fits
 * `maxChunkSize`; otherwise consecutive windows cut on row boundaries, each
 * carrying the same prefix and its own exact `lineRanges`.
 */
export function planContainerRemainder(input: ContainerRemainderInput): ContainerRemainderPart[] {
  const { codeLines, containerStartRow, coveredRows, containerHeader, hierarchyPrefix, maxChunkSize } = input;
  const runs = collectRuns(input);
  const rows = runs.flat();
  if (rows.length === 0) return [];

  // A remainder that is nothing but the container's header line (plus closing
  // punctuation) carries no code: every extracted child is already emitted
  // under that same header as its hierarchy prefix. Emitting it anyway turned
  // every constructor-only error class into a `class X extends Y {` + `}` chunk.
  const substantiveRows = rows.filter((row) => !PUNCTUATION_ONLY_ROW.test(codeLines[row]));
  if (!substantiveRows.some((row) => row !== containerStartRow)) return [];
  const substantive = substantiveRows
    .map((row) => codeLines[row])
    .join("\n")
    .trimEnd();
  if (substantive.length < input.minContentLength) return [];

  // The header row is part of the remainder unless something else carries it
  // (a child starting on the container's own first row); then it rides along
  // as context, the same convention child chunks follow.
  const headerPrefix = coveredRows.has(containerStartRow) ? `${containerHeader}\n` : "";
  const prefix = `${hierarchyPrefix}${headerPrefix}`;

  // Cut windows on row boundaries. A blank row inside a run is kept in the
  // text so the code reads as written; the window never starts or ends on one.
  const windows: number[][][] = [];
  let window: number[][] = [];
  let size = prefix.length;
  for (const run of runs) {
    let piece: number[] = [];
    for (let row = run[0]; row <= run[run.length - 1]; row++) {
      const length = (codeLines[row] ?? "").length + 1;
      if (size + length > maxChunkSize && (piece.length > 0 || window.length > 0)) {
        if (piece.length > 0) window.push(piece);
        windows.push(window);
        window = [];
        piece = [];
        size = prefix.length;
      }
      piece.push(row);
      size += length;
    }
    if (piece.length > 0) window.push(piece);
  }
  if (window.length > 0) windows.push(window);

  return windows
    .map((pieces) => pieces.map(trimBlankEdges(codeLines)).filter((piece) => piece.length > 0))
    .filter((pieces) => pieces.length > 0)
    .map((pieces) => {
      const text = pieces.map((piece) => piece.map((row) => codeLines[row]).join("\n")).join("\n");
      const lineRanges = pieces.map((piece) => ({ start: piece[0] + 1, end: piece[piece.length - 1] + 1 }));
      return {
        content: `${prefix}${text}`.trimEnd(),
        startLine: lineRanges[0].start,
        endLine: lineRanges[lineRanges.length - 1].end,
        lineRanges,
      };
    });
}

function trimBlankEdges(codeLines: readonly string[]): (piece: number[]) => number[] {
  const blank = (row: number): boolean => (codeLines[row] ?? "").trim() === "";
  return (piece) => {
    let from = 0;
    let to = piece.length - 1;
    while (from <= to && blank(piece[from])) from++;
    while (to >= from && blank(piece[to])) to--;
    return piece.slice(from, to + 1);
  };
}
