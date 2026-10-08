/**
 * Poisson tails — foundation statistics (bd tea-rags-mcp-xb669.8). The upper
 * tail is the co-change pair gate's (lifted unchanged from
 * `cochange-significance.ts`); the LOWER tail is what the dependency norms
 * judge a role pair's rarity with: P(X ≤ observed | expected).
 */
import { describe, expect, it } from "vitest";

import {
  benjaminiHochbergRejectionCount,
  CONVENTIONAL_FDR_Q,
  poissonLowerTail,
  poissonUpperTail,
} from "../../../../src/core/infra/statistics/index.js";

describe("poissonLowerTail", () => {
  it("is e^−λ at 0 and e^−λ(1 + λ) at 1", () => {
    expect(poissonLowerTail(0, 3)).toBeCloseTo(Math.exp(-3), 15);
    expect(poissonLowerTail(1, 3)).toBeCloseTo(Math.exp(-3) * 4, 15);
  });

  it("is 1 when nothing is expected and 0 below zero", () => {
    expect(poissonLowerTail(0, 0)).toBe(1);
    expect(poissonLowerTail(-1, 2)).toBe(0);
  });

  it("resolves a far lower tail instead of rounding it to 0", () => {
    // P(X ≤ 1 | 60) = e^−60 · 61 ≈ 5.3e−25 — far below 1 − (1 − ε).
    const p = poissonLowerTail(1, 60);
    expect(p).toBeGreaterThan(0);
    expect(p / (Math.exp(-60) * 61)).toBeCloseTo(1, 10);
  });

  it("complements the upper tail: P(X ≤ s) + P(X ≥ s + 1) = 1 on both sides of λ", () => {
    for (const s of [0, 2, 7, 8, 15, 40]) {
      expect(poissonLowerTail(s, 7.5) + poissonUpperTail(s + 1, 7.5)).toBeCloseTo(1, 12);
    }
  });
});

describe("statistics barrel", () => {
  it("carries the pair gate's BH procedure and its conventional q", () => {
    expect(CONVENTIONAL_FDR_Q).toBe(0.05);
    expect(benjaminiHochbergRejectionCount([0.001, 0.02, 0.9], 3)).toBe(2);
  });
});
