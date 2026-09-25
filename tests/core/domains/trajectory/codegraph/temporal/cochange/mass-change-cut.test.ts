/**
 * The adaptive mass-change cut (bd tea-rags-mcp-x4rpp): Tukey's upper fence over
 * log2 of the multi-file bundle sizes. Commit sizes are heavy-tailed, so the
 * fence is drawn on the log scale — a repository of 3-file commits and one of
 * 30-file commits each get a cut relative to their own habit, and the rename /
 * format sweeps in the tail fall outside it. The memory ceiling bounds the
 * pair count per bundle whatever the corpus says.
 */

import { describe, expect, it } from "vitest";

import {
  computeMassChangeCut,
  MASS_CHANGE_CEILING,
} from "../../../../../../../src/core/domains/trajectory/codegraph/temporal/index.js";

describe("computeMassChangeCut", () => {
  it("cuts at the Tukey upper fence of the log2 sizes", () => {
    // log2: [1,1,2,2,2,3] → Q1 = 1.25, Q3 = 2, IQR 0.75 → fence 3.125 → 2^3.125 = 8.72
    expect(computeMassChangeCut([2, 2, 4, 4, 4, 8])).toBe(8);
  });

  it("ignores single-file bundles, which carry no pair", () => {
    expect(computeMassChangeCut([1, 1, 1, 1, 2, 2, 4, 4, 4, 8])).toBe(computeMassChangeCut([2, 2, 4, 4, 4, 8]));
  });

  it("keeps an outlier sweep outside the cut", () => {
    const sizes = [...Array.from({ length: 50 }, () => 3), ...Array.from({ length: 20 }, () => 5), 400];
    const cut = computeMassChangeCut(sizes);

    expect(cut).toBeGreaterThanOrEqual(5);
    expect(cut).toBeLessThan(400);
  });

  it("never exceeds the memory ceiling and never drops a pair bundle below 2", () => {
    expect(computeMassChangeCut([100, 200, 300, 400])).toBe(MASS_CHANGE_CEILING);
    expect(computeMassChangeCut([2, 2, 2])).toBe(2);
  });

  it("falls back to the ceiling when no bundle has two files", () => {
    expect(computeMassChangeCut([])).toBe(MASS_CHANGE_CEILING);
    expect(computeMassChangeCut([1, 1])).toBe(MASS_CHANGE_CEILING);
  });
});
