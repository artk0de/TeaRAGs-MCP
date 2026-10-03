/**
 * `headRowSpanOfWorkingRows` (bd tea-rags-mcp-xi2r9, D12): a working-tree row
 * range → the HEAD rows it still holds, through the zero-context HEAD→working
 * hunks the chunk walk itself diffs with. Rows the working file added hold no
 * history; a range made only of them maps to nothing.
 */
import { structuredPatch } from "diff";
import { describe, expect, it } from "vitest";

import { headRowSpanOfWorkingRows } from "../../../../../../src/core/domains/trajectory/git/infra/offset-tracker.js";

const lines = (...rows: string[]): string => `${rows.join("\n")}\n`;
const hunksOf = (head: string, working: string) =>
  structuredPatch("f", "f", head, working, "", "", { context: 0 }).hunks;

describe("headRowSpanOfWorkingRows", () => {
  const head = lines("a", "b", "c", "d", "e");

  it("maps an unchanged file one to one", () => {
    expect(headRowSpanOfWorkingRows([], 2, 4)).toEqual({ start: 2, end: 4 });
  });

  it("shifts rows below an insertion back onto their HEAD rows", () => {
    const hunks = hunksOf(head, lines("x", "y", "a", "b", "c", "d", "e"));

    expect(headRowSpanOfWorkingRows(hunks, 3, 5)).toEqual({ start: 1, end: 3 });
  });

  it("drops the added rows of a range that mixes added and committed rows", () => {
    const hunks = hunksOf(head, lines("x", "a", "b", "c", "d", "e"));

    expect(headRowSpanOfWorkingRows(hunks, 1, 3)).toEqual({ start: 1, end: 2 });
  });

  it("answers null for a range made only of added rows", () => {
    const hunks = hunksOf(head, lines("a", "b", "c", "d", "e", "new1", "new2"));

    expect(headRowSpanOfWorkingRows(hunks, 6, 7)).toBeNull();
  });

  it("shifts rows below a deletion forward past the removed HEAD rows", () => {
    const hunks = hunksOf(head, lines("a", "d", "e"));

    expect(headRowSpanOfWorkingRows(hunks, 2, 3)).toEqual({ start: 4, end: 5 });
  });

  it("keeps a replaced row's unchanged neighbours and drops the replacement", () => {
    const hunks = hunksOf(head, lines("a", "B!", "c", "d", "e"));

    expect(headRowSpanOfWorkingRows(hunks, 1, 3)).toEqual({ start: 1, end: 3 });
    expect(headRowSpanOfWorkingRows(hunks, 2, 2)).toBeNull();
  });

  it("answers null for a file the HEAD never had", () => {
    const hunks = hunksOf("", lines("a", "b"));

    expect(headRowSpanOfWorkingRows(hunks, 1, 2)).toBeNull();
  });
});
