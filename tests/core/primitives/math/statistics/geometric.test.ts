/**
 * Geometric upper tail (bd tea-rags-mcp-r8hme.52.17): X ~ Geometric on
 * {0, 1, …} parameterised by its mean μ, P(X ≥ k) = (μ / (1 + μ))^k — the
 * null the composition-table flag tests each file's excess fan-out against.
 */
import { describe, expect, it } from "vitest";

import { geometricUpperTail } from "../../../../../src/core/primitives/math/statistics/index.js";

describe("geometricUpperTail", () => {
  it("is 1 at support 0 — every outcome is at least 0", () => {
    expect(geometricUpperTail(0, 0.4)).toBe(1);
  });

  it("is (μ / (1 + μ))^k", () => {
    expect(geometricUpperTail(1, 1)).toBeCloseTo(0.5, 12);
    expect(geometricUpperTail(3, 1)).toBeCloseTo(0.125, 12);
    expect(geometricUpperTail(2, 0.25)).toBeCloseTo(0.04, 12);
  });

  it("resolves a far tail instead of rounding it to 0", () => {
    const p = geometricUpperTail(400, 0.2);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeCloseTo(Math.exp(400 * Math.log(0.2 / 1.2)), 300);
  });

  it("is 0 above 0 when the mean is 0 — a point mass at 0", () => {
    expect(geometricUpperTail(1, 0)).toBe(0);
  });
});
