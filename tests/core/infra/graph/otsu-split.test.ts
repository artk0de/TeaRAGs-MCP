/**
 * Otsu's 1-D split (bd tea-rags-mcp-jetrd) — the adaptive cut the
 * leaking-abstraction detector draws over its facade-adoption population, and
 * the policy that turns it into the effective adoption threshold. Foundation
 * primitive since bd tea-rags-mcp-89k7k.24 (the temporal verdicts consume it
 * too), so it is tested beside its `core/infra/graph/` siblings; the
 * facade-adoption detector's own use stays with the detector, in
 * `boundary-diagnostics/leaking-abstraction.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { otsuSplit, resolveMajorityFlooredOtsuThreshold } from "../../../../src/core/infra/graph/index.js";

describe("otsuSplit", () => {
  it("cuts a bimodal set at the midpoint of the gap between its modes", () => {
    const split = otsuSplit([0.9, 0.1, 0.05, 1, 0.95, 0]);

    expect(split?.threshold).toBeCloseTo(0.5, 12);
    expect(split?.lowerValue).toBe(0.1);
    expect(split?.upperValue).toBe(0.9);
    expect(split?.separability).toBeGreaterThan(0.95);
  });

  it("maximises between-class variance w0·w1·(μ0−μ1)² and reports η = σ²between / σ²total", () => {
    const values = [0.1, 0.2, 0.3, 0.55, 0.9, 0.95, 1, 1, 1, 1];
    const split = otsuSplit(values);

    // Best cut 0.55 | 0.9: w0 = 0.4, w1 = 0.6, μ0 = 0.2875, μ1 = 0.975.
    const between = 0.4 * 0.6 * (0.975 - 0.2875) ** 2;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const total = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
    expect(split?.threshold).toBeCloseTo(0.725, 12);
    expect(split?.separability).toBeCloseTo(between / total, 12);
  });

  it("still splits a unimodal set, but with low separability", () => {
    const split = otsuSplit([0.4, 0.45, 0.5, 0.5, 0.5, 0.55, 0.6]);

    expect(split).not.toBeNull();
    expect(split?.separability).toBeLessThan(0.8);
  });

  it("cuts only between DISTINCT values, so ties stay on one side", () => {
    const split = otsuSplit([0.2, 0.2, 0.2, 0.8, 0.8]);

    expect(split).toMatchObject({ threshold: 0.5, lowerValue: 0.2, upperValue: 0.8 });
    expect(split?.separability).toBeCloseTo(1, 12);
  });

  it("has no split with fewer than two distinct values", () => {
    expect(otsuSplit([])).toBeNull();
    expect(otsuSplit([0.7, 0.7, 0.7])).toBeNull();
  });
});

/**
 * The majority-floored Otsu policy on its own (bd tea-rags-mcp-b4dcz): the
 * facade adoption threshold and the silent-coupling strength threshold are
 * the same rule over different populations, so the rule is parameterised by
 * the floor and the population size Otsu is trusted on.
 */
describe("resolveMajorityFlooredOtsuThreshold", () => {
  const options = { majority: 0.5, minPopulation: 4 };

  it("falls back to the strict majority below the minimum population", () => {
    const policy = resolveMajorityFlooredOtsuThreshold([0.1, 0.9, 0.95], options);

    expect(policy).toMatchObject({ method: "majority", threshold: 0.5 });
    expect(policy.separability).toBeUndefined();
    expect(policy.admits(0.5)).toBe(false);
    expect(policy.admits(0.51)).toBe(true);
  });

  it("raises the cut to Otsu's split when the population's own gap sits above the floor", () => {
    const policy = resolveMajorityFlooredOtsuThreshold([0.55, 0.56, 0.9, 0.92], options);

    expect(policy.method).toBe("otsu");
    expect(policy.threshold).toBeCloseTo(0.73, 12);
    expect(policy.admits(0.56)).toBe(false);
    expect(policy.admits(0.9)).toBe(true);
  });

  it("never admits a value at or below the floor, whatever Otsu says", () => {
    const policy = resolveMajorityFlooredOtsuThreshold([0.1, 0.12, 0.4, 0.45], options);

    expect(policy.method).toBe("otsu");
    expect(policy.admits(0.45)).toBe(false);
  });
});
