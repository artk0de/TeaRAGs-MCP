/**
 * Exact hypergeometric upper tail — foundation statistics (bd
 * tea-rags-mcp-gj45h). Silent coupling asks how likely a file's imports
 * reach one specific neighbour by chance: draws without replacement from the
 * corpus's import endpoints, the neighbour holding as many of them as it has
 * importers.
 */
import { describe, expect, it } from "vitest";

import { hypergeometricUpperTail } from "../../../../../src/core/primitives/math/statistics/index.js";

/** Brute-force P(X ≥ k) from the definition, small arguments only. */
function bruteForceUpperTail(successes: number, population: number, successStates: number, draws: number): number {
  const choose = (n: number, k: number): number => {
    if (k < 0 || k > n) return 0;
    let value = 1;
    for (let i = 1; i <= k; i++) value = (value * (n - k + i)) / i;
    return value;
  };
  let tail = 0;
  for (let x = successes; x <= draws; x++) {
    tail += (choose(successStates, x) * choose(population - successStates, draws - x)) / choose(population, draws);
  }
  return tail;
}

describe("hypergeometricUpperTail", () => {
  it("matches the definition over small populations", () => {
    for (const [k, N, K, n] of [
      [1, 10, 3, 2],
      [2, 20, 5, 6],
      [3, 15, 7, 7],
      [1, 45, 2, 2],
      [4, 30, 4, 10],
    ] as const) {
      expect(hypergeometricUpperTail(k, N, K, n)).toBeCloseTo(bruteForceUpperTail(k, N, K, n), 12);
    }
  });

  it("is 1 at k ≤ 0 and 0 past the attainable maximum", () => {
    expect(hypergeometricUpperTail(0, 10, 3, 2)).toBe(1);
    expect(hypergeometricUpperTail(3, 10, 3, 2)).toBe(0);
    expect(hypergeometricUpperTail(4, 10, 3, 5)).toBe(0);
  });

  it("is 1 when the draws cannot avoid the success states", () => {
    // 8 draws from 10 with only 2 failures: at least one success is certain.
    expect(hypergeometricUpperTail(1, 10, 8, 3)).toBe(1);
    expect(hypergeometricUpperTail(1, 10, 3, 8)).toBe(1);
  });

  it("resolves a far tail instead of rounding it to 0", () => {
    // P(X ≥ 1) for one success state among 1e6, a single draw: exactly 1e-6.
    expect(hypergeometricUpperTail(1, 1_000_000, 1, 1)).toBeCloseTo(1e-6, 18);
    expect(hypergeometricUpperTail(5, 100_000, 10, 50)).toBeGreaterThan(0);
  });
});
