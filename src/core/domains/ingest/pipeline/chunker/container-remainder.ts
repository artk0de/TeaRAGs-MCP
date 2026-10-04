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
  /**
   * 0-based first row of a comment block attached to the container from
   * OUTSIDE it — a recursed child's leading comment the enclosing container's
   * capture hook claimed (bd tea-rags-mcp-6wy02). Its rows join the remainder
   * ahead of the header; they are never the header row.
   */
  leadingStartRow?: number;
  containerEndRow: number;
  /** 0-based rows some other chunk already carries (children, body chunks, captured comments). */
  coveredRows: ReadonlySet<number>;
  /**
   * The container's header row, trimmed — prefixed when that row is itself
   * covered, and on every window after the one that carries it. Empty for a
   * region with no header row (the module remainder): nothing is prefixed.
   */
  containerHeader: string;
  /**
   * 0-based row `containerHeader` was read from — the row naming the container,
   * which follows any attribute rows (bd tea-rags-mcp-j4jrn). Defaults to
   * `containerStartRow`.
   */
  containerHeaderRow?: number;
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
  const firstRow = Math.min(input.leadingStartRow ?? containerStartRow, containerStartRow);
  const runs: number[][] = [];
  let current: number[] = [];
  for (let row = firstRow; row <= containerEndRow; row++) {
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
 * with its own exact `lineRanges`, and every window after the one holding the
 * header row opening with the hierarchy prefix plus the container header.
 */
export function planContainerRemainder(input: ContainerRemainderInput): ContainerRemainderPart[] {
  const { codeLines, coveredRows, containerHeader, hierarchyPrefix, maxChunkSize } = input;
  const headerRow = input.containerHeaderRow ?? input.containerStartRow;
  const runs = collectRuns(input);
  const rows = runs.flat();
  if (rows.length === 0) return [];

  // A remainder that is nothing but the container's header line (plus closing
  // punctuation) carries no code: every extracted child is already emitted
  // under that same header as its hierarchy prefix. Emitting it anyway turned
  // every constructor-only error class into a `class X extends Y {` + `}` chunk.
  const substantiveRows = rows.filter((row) => !PUNCTUATION_ONLY_ROW.test(codeLines[row]));
  if (!substantiveRows.some((row) => row !== headerRow)) return [];
  const substantive = substantiveRows
    .map((row) => codeLines[row])
    .join("\n")
    .trimEnd();
  if (substantive.length < input.minContentLength) return [];

  // The header row is part of the remainder unless something else carries it
  // (a child starting on the container's own first row); then it rides along
  // as context, the same convention child chunks follow.
  // A window after the one carrying the header row names the container through
  // the same header prefix — otherwise a top-level container's `#part2+` named
  // nothing at all (bd tea-rags-mcp-j4jrn).
  // A headerless region — the MODULE remainder, whose "container" is the file —
  // passes an empty header and gets no header prefix at all.
  const headerPrefix = containerHeader === "" ? "" : `${containerHeader}\n`;
  const ownHeaderPrefix = coveredRows.has(headerRow) ? headerPrefix : "";
  const tailPrefix = `${hierarchyPrefix}${headerPrefix}`;

  // Cut windows on row boundaries. A blank row inside a run is kept in the
  // text so the code reads as written; the window never starts or ends on one.
  const windows: { prefix: string; pieces: number[][] }[] = [];
  let window: number[][] = [];
  let prefix = `${hierarchyPrefix}${ownHeaderPrefix}`;
  let size = prefix.length;
  let lastPlacedRow = -1;
  for (const run of runs) {
    let piece: number[] = [];
    for (let row = run[0]; row <= run[run.length - 1]; row++) {
      const length = (codeLines[row] ?? "").length + 1;
      if (size + length > maxChunkSize && (piece.length > 0 || window.length > 0)) {
        if (piece.length > 0) window.push(piece);
        windows.push({ prefix, pieces: window });
        window = [];
        piece = [];
        prefix = lastPlacedRow >= headerRow ? tailPrefix : `${hierarchyPrefix}${ownHeaderPrefix}`;
        size = prefix.length;
      }
      piece.push(row);
      lastPlacedRow = row;
      size += length;
    }
    if (piece.length > 0) window.push(piece);
  }
  if (window.length > 0) windows.push({ prefix, pieces: window });

  return windows
    .map((w) => ({
      prefix: w.prefix,
      pieces: w.pieces.map(trimBlankEdges(codeLines)).filter((piece) => piece.length > 0),
    }))
    .filter((w) => w.pieces.length > 0)
    .map(({ prefix: windowPrefix, pieces }) => {
      const text = pieces.map((piece) => piece.map((row) => codeLines[row]).join("\n")).join("\n");
      const lineRanges = pieces.map((piece) => ({ start: piece[0] + 1, end: piece[piece.length - 1] + 1 }));
      return {
        content: `${windowPrefix}${text}`.trimEnd(),
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
