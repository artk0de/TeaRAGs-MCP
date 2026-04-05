import { describe, expect, it } from "vitest";

import {
  type AdjustedRange,
  applyOffsets,
  mapHunksToChunks,
} from "../../../../../../src/core/domains/trajectory/git/infra/offset-tracker.js";

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

describe("mapHunksToChunks", () => {
  it("maps hunk to overlapping chunk using adjusted ranges", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 10, end: 20 },
      { chunkId: "B", start: 30, end: 40 },
    ];
    const hunks: Hunk[] = [{ oldStart: 10, oldLines: 3, newStart: 12, newLines: 5 }];
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected).toContain("A");
    expect(affected).not.toContain("B");
  });

  it("maps hunk overlapping multiple chunks", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 10, end: 20 },
      { chunkId: "B", start: 21, end: 30 },
    ];
    const hunks: Hunk[] = [{ oldStart: 15, oldLines: 10, newStart: 15, newLines: 12 }];
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected).toContain("A");
    expect(affected).toContain("B");
  });

  it("returns empty set when no overlap", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 50, end: 60 }];
    const hunks: Hunk[] = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 5 }];
    const affected = mapHunksToChunks(hunks, ranges);
    expect(affected.size).toBe(0);
  });
});

describe("applyOffsets", () => {
  it("shifts chunks BELOW a hunk by insertion delta", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    const hunks: Hunk[] = [{ oldStart: 12, oldLines: 2, newStart: 12, newLines: 5 }];
    const adjusted = applyOffsets(ranges, hunks);
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({ chunkId: "A", start: 5, end: 10 });
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(17);
    expect(b.end).toBe(27);
  });

  it("shifts chunks BELOW a hunk by deletion delta", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    const hunks: Hunk[] = [{ oldStart: 8, oldLines: 5, newStart: 8, newLines: 2 }];
    const adjusted = applyOffsets(ranges, hunks);
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(23);
    expect(b.end).toBe(33);
  });

  it("resizes chunk when hunk is INSIDE it (insertion)", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 10, end: 30 }];
    const hunks: Hunk[] = [{ oldStart: 15, oldLines: 2, newStart: 15, newLines: 5 }];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    expect(a.start).toBe(10);
    expect(a.end).toBe(27);
  });

  it("resizes chunk when hunk is INSIDE it (deletion)", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 10, end: 30 }];
    const hunks: Hunk[] = [{ oldStart: 15, oldLines: 5, newStart: 15, newLines: 2 }];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    expect(a.start).toBe(10);
    expect(a.end).toBe(33);
  });

  it("handles multiple hunks bottom-to-top to avoid cascading", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 25 },
      { chunkId: "C", start: 40, end: 50 },
    ];
    const hunks: Hunk[] = [
      { oldStart: 12, oldLines: 1, newStart: 12, newLines: 4 },
      { oldStart: 28, oldLines: 1, newStart: 30, newLines: 3 },
    ];
    const adjusted = applyOffsets(ranges, hunks);
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({ chunkId: "A", start: 5, end: 10 });
    const b = adjusted.find((r) => r.chunkId === "B")!;
    expect(b.start).toBe(17);
    expect(b.end).toBe(22);
    const c = adjusted.find((r) => r.chunkId === "C")!;
    expect(c.start).toBe(35);
    expect(c.end).toBe(45);
  });

  it("does not shift chunks ABOVE hunk", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 5, end: 10 }];
    const hunks: Hunk[] = [{ oldStart: 20, oldLines: 2, newStart: 20, newLines: 5 }];
    const adjusted = applyOffsets(ranges, hunks);
    expect(adjusted[0]).toEqual({ chunkId: "A", start: 5, end: 10 });
  });

  it("handles zero-delta hunk (pure replacement, same line count)", () => {
    const ranges: AdjustedRange[] = [
      { chunkId: "A", start: 5, end: 10 },
      { chunkId: "B", start: 20, end: 30 },
    ];
    const hunks: Hunk[] = [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 3 }];
    const adjusted = applyOffsets(ranges, hunks);
    expect(adjusted.find((r) => r.chunkId === "A")).toEqual({ chunkId: "A", start: 5, end: 10 });
    expect(adjusted.find((r) => r.chunkId === "B")).toEqual({ chunkId: "B", start: 20, end: 30 });
  });

  it("prevents negative start after large deletion", () => {
    const ranges: AdjustedRange[] = [{ chunkId: "A", start: 2, end: 5 }];
    const hunks: Hunk[] = [{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 0 }];
    const adjusted = applyOffsets(ranges, hunks);
    const a = adjusted.find((r) => r.chunkId === "A")!;
    expect(a.start).toBeGreaterThanOrEqual(1);
    expect(a.end).toBeGreaterThanOrEqual(a.start);
  });

  it("returns empty array for empty input", () => {
    expect(applyOffsets([], [])).toEqual([]);
  });
});
