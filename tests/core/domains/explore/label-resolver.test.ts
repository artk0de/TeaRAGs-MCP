import { describe, expect, it } from "vitest";

import { resolveLabel } from "../../../../src/core/domains/explore/label-resolver.js";

describe("resolveLabel", () => {
  const labels = { p25: "low", p50: "typical", p75: "high", p95: "extreme" };
  const percentiles = { 25: 2, 50: 5, 75: 12, 95: 30 };

  it("should return first label for values below all thresholds", () => {
    expect(resolveLabel(0, labels, percentiles)).toBe("low");
    expect(resolveLabel(1, labels, percentiles)).toBe("low");
  });

  it("should return first label for values in first bucket", () => {
    expect(resolveLabel(2, labels, percentiles)).toBe("low");
    expect(resolveLabel(4, labels, percentiles)).toBe("low");
  });

  it("should return correct bucket label", () => {
    expect(resolveLabel(5, labels, percentiles)).toBe("typical");
    expect(resolveLabel(11, labels, percentiles)).toBe("typical");
    expect(resolveLabel(12, labels, percentiles)).toBe("high");
    expect(resolveLabel(29, labels, percentiles)).toBe("high");
  });

  it("should return last label for values at or above last threshold", () => {
    expect(resolveLabel(30, labels, percentiles)).toBe("extreme");
    expect(resolveLabel(100, labels, percentiles)).toBe("extreme");
  });

  it("should handle two-label signals", () => {
    const twoLabels = { p75: "normal", p95: "high" };
    const twoPercentiles = { 75: 10, 95: 25 };
    expect(resolveLabel(5, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(10, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(15, twoLabels, twoPercentiles)).toBe("normal");
    expect(resolveLabel(25, twoLabels, twoPercentiles)).toBe("high");
    expect(resolveLabel(50, twoLabels, twoPercentiles)).toBe("high");
  });

  it("should return empty string when labels map is empty", () => {
    expect(resolveLabel(100, {}, { 50: 5 })).toBe("");
  });

  it("should handle collapsed percentiles (identical values)", () => {
    const collapsed = { p25: "low", p50: "typical", p75: "high", p95: "extreme" };
    const sameValues = { 25: 5, 50: 5, 75: 5, 95: 5 };
    // All thresholds are 5, value 3 < 5 → first label
    expect(resolveLabel(3, collapsed, sameValues)).toBe("low");
    // Value 5 >= all thresholds → last label
    expect(resolveLabel(5, collapsed, sameValues)).toBe("extreme");
  });
});
