/**
 * Per-file chunk range offset tracking for drift-free hunk→chunk mapping.
 *
 * When processing commits newest→oldest, chunk line ranges (defined at HEAD)
 * must be adjusted backward through each commit's insertions/deletions.
 *
 * Hunks are ZERO-CONTEXT (`structuredPatch(..., { context: 0 })` in
 * walk-commits.ts): every row a hunk spans was added or removed by the commit.
 * A context row is not a change, and crediting it lands a commit on every
 * chunk within the context radius of an edit — which `git log -L` never does
 * (bd tea-rags-mcp-z3cnd). jsdiff places a pure deletion (`newLines === 0`) at
 * the new-side row that FOLLOWS the removed rows, so the deletion sits on the
 * seam just above `newStart`.
 *
 * Pure functions — no I/O, no git dependency.
 */

export interface AdjustedRange {
  chunkId: string;
  start: number;
  end: number;
  /**
   * Every row of the chunk was inserted by a newer commit: it has no rows in
   * the older commits, and none of them credits it — `git log -L` stops at the
   * commit that added the range (bd tea-rags-mcp-xi2r9). Absent while any row
   * still has an ancestor.
   */
  retired?: true;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/** Rows one zero-context hunk changed inside one chunk range. */
export interface ChunkChangedRows {
  /** Added rows that fall inside the range. */
  added: number;
  /** Removed rows attributed to the range. */
  deleted: number;
}

/**
 * Rows `hunk` changed inside `range`, or `null` when it changed none — the one
 * predicate every per-chunk walk signal shares (commit crediting and churn).
 *
 * Added rows credit the range they overlap; a replacement's removed rows are
 * spread over its added rows proportionally. A pure deletion credits the range
 * only when its seam lies strictly INSIDE it (`start < newStart <= end`): the
 * removed rows sat between two of the range's rows. A deletion on the seam
 * between two chunks credits neither — `git log -L` does the same.
 */
export function changedRowsInRange(
  hunk: Hunk,
  range: { start: number; end: number; retired?: true },
): ChunkChangedRows | null {
  if (range.retired) return null;
  if (hunk.newLines === 0) {
    return range.start < hunk.newStart && hunk.newStart <= range.end ? { added: 0, deleted: hunk.oldLines } : null;
  }
  const lastNew = hunk.newStart + hunk.newLines - 1;
  const overlap = Math.min(lastNew, range.end) - Math.max(hunk.newStart, range.start) + 1;
  if (overlap <= 0) return null;
  return { added: overlap, deleted: Math.round((hunk.oldLines * overlap) / hunk.newLines) };
}

/**
 * Map hunks to the chunks whose rows they changed, using current adjusted
 * ranges. Returns Set of affected chunkIds.
 */
export function mapHunksToChunks(hunks: Hunk[], ranges: AdjustedRange[]): Set<string> {
  const affected = new Set<string>();
  for (const hunk of hunks) {
    for (const r of ranges) {
      if (changedRowsInRange(hunk, r) !== null) affected.add(r.chunkId);
    }
  }
  return affected;
}

/**
 * Map one new-side row through a single hunk into the parent's rows, in the
 * coordinates of the hunks not yet undone (rows above the hunk are unchanged).
 * A row after the hunk shifts by `-(newLines - oldLines)`; a row inside the
 * added block keeps its offset, clamped into the removed block. A row with no
 * counterpart (inside a pure insertion) lands per `edge`: a chunk START on the
 * row that followed the insertion, an END on the row before it.
 */
function rowBeforeHunk(row: number, hunk: Hunk, edge: "start" | "end"): number {
  const blockEnd = hunk.newStart + hunk.newLines; // exclusive
  if (row >= blockEnd) return row - (hunk.newLines - hunk.oldLines);
  if (row < hunk.newStart) return row;
  if (hunk.oldLines === 0) return edge === "start" ? hunk.newStart : hunk.newStart - 1;
  return hunk.newStart + Math.min(row - hunk.newStart, hunk.oldLines - 1);
}

/**
 * Apply offset corrections to adjusted ranges for the next (older) commit.
 *
 * Each range boundary is mapped through every hunk (`rowBeforeHunk`): rows
 * below a hunk shift by its delta, rows above stay, rows inside its added block
 * clamp into its removed block. So a chunk a hunk sits inside grows or shrinks
 * by the delta, and a chunk starting right after a pure deletion moves down
 * past the removed rows instead of absorbing them.
 *
 * Hunks are processed bottom-to-top (sorted by newStart DESC) to prevent
 * cascading shift errors.
 *
 * Returns new array of AdjustedRange (does not mutate input).
 */
export function applyOffsets(ranges: AdjustedRange[], hunks: Hunk[]): AdjustedRange[] {
  if (ranges.length === 0) return [];

  const result: AdjustedRange[] = ranges.map((r) => ({ ...r }));

  const sorted = [...hunks].sort((a, b) => b.newStart - a.newStart);

  for (const hunk of sorted) {
    if (hunk.newLines === hunk.oldLines) continue;
    for (const r of result) {
      if (r.retired) continue;
      if (hunk.oldLines === 0 && hunk.newStart <= r.start && r.end < hunk.newStart + hunk.newLines) {
        // Wholly inside a pure insertion: no row of it existed before.
        r.retired = true;
        continue;
      }
      r.start = rowBeforeHunk(r.start, hunk, "start");
      r.end = rowBeforeHunk(r.end, hunk, "end");
    }
  }

  for (const r of result) {
    r.start = Math.max(r.start, 1);
    r.end = Math.max(r.end, r.start);
  }

  return result;
}

/**
 * The HEAD rows a working-tree row range still holds (bd tea-rags-mcp-xi2r9,
 * D12), through the zero-context HEAD → working hunks — the same hunk shape the
 * walk diffs commits with, the working file as the new side. A row inside an
 * added block has no HEAD counterpart: it was never committed, so it holds no
 * history. Answers the span from the first to the last committed row, in HEAD
 * coordinates, or `null` when every row of the range is uncommitted.
 */
export function headRowSpanOfWorkingRows(
  hunks: readonly Hunk[],
  start: number,
  end: number,
): { start: number; end: number } | null {
  const sorted = [...hunks].sort((a, b) => a.newStart - b.newStart);
  let first: number | null = null;
  let last: number | null = null;
  for (let row = start; row <= end; row++) {
    const headRow = headRowOfWorkingRow(sorted, row);
    if (headRow === null) continue;
    first ??= headRow;
    last = headRow;
  }
  return first === null || last === null ? null : { start: first, end: last };
}

/** One working row's HEAD row, or `null` when an added block holds it. `hunks` sorted by `newStart`. */
function headRowOfWorkingRow(hunks: readonly Hunk[], row: number): number | null {
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.newLines === 0) {
      // A pure deletion sits on the seam above `newStart`: rows from it on shift past the removed rows.
      if (row < hunk.newStart) break;
      offset += hunk.oldLines;
      continue;
    }
    if (row < hunk.newStart) break;
    if (row < hunk.newStart + hunk.newLines) return null;
    offset += hunk.oldLines - hunk.newLines;
  }
  return row + offset;
}
