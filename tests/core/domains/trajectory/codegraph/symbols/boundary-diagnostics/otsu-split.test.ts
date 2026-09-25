/**
 * Otsu's 1-D split (bd tea-rags-mcp-jetrd) — the adaptive cut the
 * leaking-abstraction detector draws over its facade-adoption population, and
 * the policy that turns it into the effective adoption threshold.
 */
import { describe, expect, it } from "vitest";

import {
  FACADE_ADOPTION_MAJORITY,
  FACADE_OTSU_MIN_POPULATION,
  otsuSplit,
  resolveFacadeAdoptionThreshold,
} from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/index.js";

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

describe("resolveFacadeAdoptionThreshold", () => {
  it("falls back to the strict majority below the minimum population", () => {
    expect(FACADE_OTSU_MIN_POPULATION).toBe(8);
    expect(FACADE_ADOPTION_MAJORITY).toBe(0.5);
    const policy = resolveFacadeAdoptionThreshold([0, 0, 0.1, 0.9, 1, 1, 1]);

    expect(policy.method).toBe("majority");
    expect(policy.threshold).toBe(0.5);
    expect(policy.separability).toBeUndefined();
    expect(policy.admits(0.5)).toBe(false);
    expect(policy.admits(0.51)).toBe(true);
  });

  it("falls back to the majority when the population has one distinct value", () => {
    const policy = resolveFacadeAdoptionThreshold(Array.from({ length: 9 }, () => 1));

    expect(policy.method).toBe("majority");
    expect(policy.admits(1)).toBe(true);
  });

  it("uses the Otsu cut at or above it, never admitting a value at or below the majority", () => {
    const policy = resolveFacadeAdoptionThreshold([0.1, 0.2, 0.3, 0.55, 0.9, 0.95, 1, 1, 1, 1]);

    expect(policy.method).toBe("otsu");
    expect(policy.threshold).toBeCloseTo(0.725, 12);
    expect(policy.separability).toBeGreaterThan(0.9);
    expect(policy.admits(policy.threshold)).toBe(true);
    expect(policy.admits(0.9)).toBe(true);
    expect(policy.admits(0.55)).toBe(false);
  });

  it("keeps the strict majority floor when the Otsu cut falls below it", () => {
    const policy = resolveFacadeAdoptionThreshold([0, 0, 0, 0, 0.5, 0.5, 0.6, 0.7]);

    expect(policy.method).toBe("otsu");
    expect(policy.threshold).toBeCloseTo(0.25, 12);
    expect(policy.admits(0.5)).toBe(false);
    expect(policy.admits(0.6)).toBe(true);
  });
});
