/**
 * Šidák correction of a minimum p-value — foundation statistics (bd
 * tea-rags-mcp-v4279). Silent coupling keeps the least likely of a pair's
 * shared neighbours, so the reported chance is that of the best of k tests.
 */
import { describe, expect, it } from "vitest";

import { sidakCorrectedMinimumPValue } from "../../../../../src/core/primitives/math/statistics/index.js";

describe("sidakCorrectedMinimumPValue", () => {
  it("is 1 − (1 − p)^k", () => {
    expect(sidakCorrectedMinimumPValue(0.02, 10)).toBeCloseTo(1 - 0.98 ** 10, 12);
    expect(sidakCorrectedMinimumPValue(0.3, 3)).toBeCloseTo(1 - 0.7 ** 3, 12);
  });

  it("leaves a single comparison, or fewer, uncorrected", () => {
    expect(sidakCorrectedMinimumPValue(0.04, 1)).toBeCloseTo(0.04, 15);
    expect(sidakCorrectedMinimumPValue(0.04, 0)).toBeCloseTo(0.04, 15);
  });

  it("keeps the digits of a tiny p, about k·p, where 1 − (1 − p)^k would round", () => {
    expect(sidakCorrectedMinimumPValue(1e-18, 5)).toBeCloseTo(5e-18, 30);
  });

  it("stays inside [0, 1] at the ends", () => {
    expect(sidakCorrectedMinimumPValue(0, 50)).toBe(0);
    expect(sidakCorrectedMinimumPValue(1, 50)).toBe(1);
  });
});
