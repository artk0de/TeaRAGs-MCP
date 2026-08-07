import { describe, expect, it } from "vitest";

import { computeScoreBackground } from "../../../../../src/core/domains/ingest/infra/score-background.js";

/**
 * The score background is the collection's own similarity scale: cosine between
 * random pairs of stored vectors. Search confidence reads a result set as a
 * z-score against it, which is what keeps the mechanism free of any constant
 * belonging to the embedding model.
 */
describe("computeScoreBackground", () => {
  /** Deterministic spread of unit vectors in the first two dimensions. */
  function fan(count: number): number[][] {
    return Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI;
      return [Math.cos(angle), Math.sin(angle), 0];
    });
  }

  it("measures mean and dispersion of pairwise cosine similarity", () => {
    const background = computeScoreBackground(fan(400));
    expect(background).toBeDefined();
    expect(background!.mean).toBeGreaterThan(-1);
    expect(background!.mean).toBeLessThan(1);
    expect(background!.stddev).toBeGreaterThan(0);
    expect(background!.sampleCount).toBe(200); // 400 vectors → 200 disjoint pairs
  });

  it("reports a tight background for a collection whose vectors are near-identical", () => {
    const clustered = Array.from({ length: 400 }, (_, i) => [1, i * 1e-6, 0]);
    const background = computeScoreBackground(clustered);
    // Every pair is ~parallel: mean cosine ≈ 1 with almost no dispersion.
    expect(background!.mean).toBeCloseTo(1, 4);
    expect(background!.stddev).toBeLessThan(0.01);
  });

  it("is invariant to vector magnitude — cosine, not dot product", () => {
    const unit = fan(200);
    const scaled = unit.map((v, i) => v.map((x) => x * (1 + i)));
    expect(computeScoreBackground(scaled)!.mean).toBeCloseTo(computeScoreBackground(unit)!.mean, 6);
  });

  it("returns undefined when the sample is too small to describe a distribution", () => {
    expect(computeScoreBackground(fan(20))).toBeUndefined();
    expect(computeScoreBackground([])).toBeUndefined();
  });

  it("skips vectors of mismatched arity rather than producing NaN", () => {
    const mixed = [...fan(400), [1, 0], [0, 1, 0, 0]];
    const background = computeScoreBackground(mixed);
    expect(Number.isFinite(background!.mean)).toBe(true);
    expect(Number.isFinite(background!.stddev)).toBe(true);
  });

  it("tolerates zero vectors without dividing by zero", () => {
    const withZeros = fan(400).map((v, i) => (i % 50 === 0 ? [0, 0, 0] : v));
    const background = computeScoreBackground(withZeros);
    expect(Number.isFinite(background!.mean)).toBe(true);
  });
});
