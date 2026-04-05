/**
 * Per-file chunk range offset tracking for drift-free hunk→chunk mapping.
 *
 * When processing commits newest→oldest, chunk line ranges (defined at HEAD)
 * must be adjusted backward through each commit's insertions/deletions.
 *
 * Pure functions — no I/O, no git dependency.
 */

export interface AdjustedRange {
  chunkId: string;
  start: number;
  end: number;
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * Map hunks to overlapping chunks using current adjusted ranges.
 * Returns Set of affected chunkIds.
 */
export function mapHunksToChunks(hunks: Hunk[], ranges: AdjustedRange[]): Set<string> {
  const affected = new Set<string>();
  for (const hunk of hunks) {
    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);
    for (const r of ranges) {
      if (hunkStart <= r.end && hunkEnd >= r.start) {
        affected.add(r.chunkId);
      }
    }
  }
  return affected;
}

/**
 * Apply offset corrections to adjusted ranges for the next (older) commit.
 *
 * For each hunk, computes delta = newLines - oldLines:
 * - Chunks BELOW hunk: shift start/end by -delta
 * - Chunks CONTAINING hunk (hunk entirely inside chunk): shrink/expand end by -delta
 * - Chunks ABOVE hunk: no change
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
    const delta = hunk.newLines - hunk.oldLines;
    if (delta === 0) continue;

    const hunkStart = hunk.newStart;
    const hunkEnd = hunk.newStart + Math.max(hunk.newLines - 1, 0);

    for (const r of result) {
      if (r.start > hunkEnd) {
        r.start -= delta;
        r.end -= delta;
      } else if (hunkStart >= r.start && hunkEnd <= r.end) {
        r.end -= delta;
      }
    }
  }

  for (const r of result) {
    r.start = Math.max(r.start, 1);
    r.end = Math.max(r.end, r.start);
  }

  return result;
}
