/**
 * Exact binomial tail and the two-sided sign test built on it — foundation
 * statistics (bd tea-rags-mcp-xb669.8). The dependency norms judge a role
 * pair's DIRECTION with the sign test: n(A→B) against n(B→A) at p = ½.
 */
import { describe, expect, it } from "vitest";

import { binomialLowerTail, signTestPValue } from "../../../../src/core/infra/statistics/index.js";

describe("binomialLowerTail", () => {
  it("sums the exact terms: P(X ≤ 1 | n = 4, ½) = 5/16", () => {
    expect(binomialLowerTail(1, 4, 0.5)).toBeCloseTo(5 / 16, 15);
    expect(binomialLowerTail(0, 3, 0.2)).toBeCloseTo(0.8 ** 3, 15);
  });

  it("is 1 at or above n and 0 below zero", () => {
    expect(binomialLowerTail(4, 4, 0.5)).toBe(1);
    expect(binomialLowerTail(9, 4, 0.5)).toBe(1);
    expect(binomialLowerTail(-1, 4, 0.5)).toBe(0);
  });

  it("resolves a far tail instead of rounding it to 0", () => {
    // P(X ≤ 1 | n = 200, ½) = 201 / 2^200 ≈ 1.25e−58.
    const p = binomialLowerTail(1, 200, 0.5);
    expect(p).toBeGreaterThan(0);
    expect(p / (201 * 2 ** -200)).toBeCloseTo(1, 10);
  });

  it("stays a probability above the mode, where the summed terms first grow", () => {
    expect(binomialLowerTail(60, 100, 0.5)).toBeGreaterThan(0.97);
    expect(binomialLowerTail(60, 100, 0.5)).toBeLessThan(1);
    expect(binomialLowerTail(50, 100, 0.5) + binomialLowerTail(49, 100, 0.5)).toBeCloseTo(1, 12);
  });
});

describe("signTestPValue", () => {
  it("is twice the minority's tail: 24 against 1 is 2·26/2^25", () => {
    expect(signTestPValue(24, 1) / ((2 * 26) / 2 ** 25)).toBeCloseTo(1, 12);
    expect(signTestPValue(1, 24)).toBe(signTestPValue(24, 1));
  });

  it("never exceeds 1: a near-even split and an empty pair carry no evidence", () => {
    expect(signTestPValue(62, 61)).toBeCloseTo(1, 12);
    expect(signTestPValue(2, 1)).toBeCloseTo(1, 12);
    expect(signTestPValue(0, 0)).toBe(1);
  });

  it("reads a one-way pair as 2^(1 − n): 3 against 0 is ¼", () => {
    expect(signTestPValue(3, 0)).toBeCloseTo(0.25, 15);
    expect(signTestPValue(772, 0)).toBeGreaterThan(0);
  });
});
