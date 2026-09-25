/**
 * Row-space splitter shared by every chunker that has to cut an oversized
 * region into parts: the tree-sitter oversized-symbol path, the markdown
 * section path and the syntax-neutral character path. Callers translate their
 * structure (AST nodes, mdast blocks, bracket pairs) into NESTING SPANS — row
 * ranges of constructs that should stay whole — and this module decides where
 * the region is cut.
 *
 * The rule: a cut between two rows is as cheap as the number of spans it falls
 * inside. A region that does not fit is divided at its SHALLOWEST cuts only —
 * between the statements of a body, the items of a list, the top-level entries
 * of a JSON object — and the resulting units are packed greedily. A unit that
 * alone does not fit is divided again by the same rule, which moves one level
 * deeper (the body of the `if`, the entries of the nested object). Only a row
 * wider than the budget on its own is cut by characters.
 *
 * Budgets are per part start: `capacityAt(row)` returns the characters a part
 * starting at `row` may spend on its own rows, which is how a caller reserves
 * room for the context prefix it will prepend to that part.
 */

/** A multi-row construct that should stay whole: rows `[startRow, endRow]`, inclusive. */
export interface NestingSpan {
  readonly startRow: number;
  readonly endRow: number;
}

export interface NestingSplitInput {
  /** Text of every row of the region, in order. */
  readonly rows: readonly string[];
  /** Constructs to keep whole where possible. Rows outside `rows` are clipped. */
  readonly spans: readonly NestingSpan[];
  /** Characters available to the rows of a part starting at `row` (newlines included). */
  readonly capacityAt: (row: number) => number;
  /**
   * Rows that OPEN something (`if (x) {`, a signature, a table header): the
   * cut right after such a row is one level deeper than its neighbours, so an
   * opening row stays with the first row it opens instead of ending a part on
   * its own.
   */
  readonly openingRows?: Iterable<number>;
}

/** One part: rows `[startRow, endRow]`; `columns` only for a row wider than its capacity. */
export interface NestingSplitPart {
  startRow: number;
  endRow: number;
  columns?: { start: number; end: number };
}

/** Floor for a character slice, so a starved capacity cannot loop on empty slices. */
const MIN_SLICE_CHARS = 64;

export class NestingLineSplitter {
  private readonly rowOffsets: number[];
  private readonly cutDepth: number[];
  private readonly capacityCache = new Map<number, number>();

  constructor(private readonly input: NestingSplitInput) {
    const { rows } = input;
    this.rowOffsets = new Array<number>(rows.length + 1);
    this.rowOffsets[0] = 0;
    for (let i = 0; i < rows.length; i++) this.rowOffsets[i + 1] = this.rowOffsets[i] + rows[i].length;
    this.cutDepth = NestingLineSplitter.computeCutDepth(rows.length, input.spans);
    for (const row of new Set(input.openingRows ?? [])) {
      if (row >= 0 && row < this.cutDepth.length) this.cutDepth[row]++;
    }
  }

  /** Cut the whole region. An empty region yields no parts. */
  split(): NestingSplitPart[] {
    if (this.input.rows.length === 0) return [];
    return this.splitRange(0, this.input.rows.length - 1);
  }

  /** Nesting depth of the cut between `row` and `row + 1`; 0 outside the region. */
  cutDepthAfter(row: number): number {
    return this.cutDepth[row] ?? 0;
  }

  /** Characters of rows `[a, b]` joined by newlines. */
  sizeOf(a: number, b: number): number {
    return this.rowOffsets[b + 1] - this.rowOffsets[a] + (b - a);
  }

  /**
   * `cutDepth[r]` = number of spans the cut between row `r` and row `r + 1`
   * falls strictly inside (`startRow <= r < endRow`), plus one when `r` is an
   * opening row.
   */
  private static computeCutDepth(rowCount: number, spans: readonly NestingSpan[]): number[] {
    const diff = new Array<number>(rowCount + 1).fill(0);
    for (const span of spans) {
      const start = Math.max(0, span.startRow);
      const end = Math.min(rowCount - 1, span.endRow);
      if (end <= start) continue;
      diff[start]++;
      diff[end]--;
    }
    const depth = new Array<number>(Math.max(0, rowCount - 1));
    let running = 0;
    for (let r = 0; r < rowCount - 1; r++) {
      running += diff[r];
      depth[r] = running;
    }
    return depth;
  }

  private capacityAt(row: number): number {
    let cached = this.capacityCache.get(row);
    if (cached === undefined) {
      cached = this.input.capacityAt(row);
      this.capacityCache.set(row, cached);
    }
    return cached;
  }

  private fits(a: number, b: number): boolean {
    return this.sizeOf(a, b) <= this.capacityAt(a);
  }

  private splitRange(a: number, b: number): NestingSplitPart[] {
    if (this.fits(a, b)) return [{ startRow: a, endRow: b }];
    if (a === b) return this.sliceRow(a);

    let shallowest = Number.POSITIVE_INFINITY;
    for (let r = a; r < b; r++) shallowest = Math.min(shallowest, this.cutDepth[r]);

    const units: [number, number][] = [];
    let unitStart = a;
    for (let r = a; r < b; r++) {
      if (this.cutDepth[r] !== shallowest) continue;
      units.push([unitStart, r]);
      unitStart = r + 1;
    }
    units.push([unitStart, b]);

    const parts: NestingSplitPart[] = [];
    let current: NestingSplitPart | undefined;
    for (const [unitFrom, unitTo] of units) {
      if (current && this.fits(current.startRow, unitTo)) {
        current.endRow = unitTo;
        continue;
      }
      if (this.fits(unitFrom, unitTo)) {
        if (current) parts.push(current);
        current = { startRow: unitFrom, endRow: unitTo };
        continue;
      }
      // The unit alone does not fit: divide it one nesting level deeper. The
      // open part may take the unit's first piece (the cut after it is inside
      // an oversized unit, where cutting is allowed anyway), and the unit's
      // last piece stays open so the following units can still join it.
      const inner = this.splitRange(unitFrom, unitTo);
      const first = inner[0];
      if (current && !first.columns && this.fits(current.startRow, first.endRow)) {
        current.endRow = first.endRow;
        inner.shift();
        if (inner.length === 0) continue;
      }
      if (current) parts.push(current);
      current = undefined;
      const last = inner.pop();
      parts.push(...inner);
      if (last?.columns) parts.push(last);
      else current = last;
    }
    if (current) parts.push(current);
    return parts;
  }

  /** A single row wider than its capacity: the only place a row is cut by characters. */
  private sliceRow(row: number): NestingSplitPart[] {
    const text = this.input.rows[row];
    const width = Math.max(MIN_SLICE_CHARS, this.capacityAt(row));
    const parts: NestingSplitPart[] = [];
    for (let start = 0; start < text.length; start += width) {
      parts.push({ startRow: row, endRow: row, columns: { start, end: Math.min(text.length, start + width) } });
    }
    return parts;
  }
}
