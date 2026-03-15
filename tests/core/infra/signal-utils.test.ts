import { describe, expect, it } from "vitest";

import {
  blend,
  computeAlpha,
  confidenceDampening,
  DEFAULT_CHUNK_MATURITY_THRESHOLD,
  normalize,
  p95,
} from "../../../src/core/infra/signal-utils.js";

describe("normalize", () => {
  it("returns value/max clamped to [0, 1]", () => {
    expect(normalize(50, 100)).toBe(0.5);
    expect(normalize(0, 100)).toBe(0);
    expect(normalize(200, 100)).toBe(1);
  });

  it("returns 0 for max <= 0", () => {
    expect(normalize(50, 0)).toBe(0);
    expect(normalize(50, -1)).toBe(0);
  });
});

describe("p95", () => {
  it("returns 95th percentile", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(arr)).toBe(96);
  });

  it("returns 1 for empty array", () => {
    expect(p95([])).toBe(1);
  });
});

describe("computeAlpha", () => {
  it("returns 0 when chunk count is 0 or undefined", () => {
    expect(computeAlpha(0, 20)).toBe(0);
    expect(computeAlpha(undefined, 20)).toBe(0);
  });

  it("returns 0 when file count is 0 or undefined", () => {
    expect(computeAlpha(10, 0)).toBe(0);
    expect(computeAlpha(10, undefined)).toBe(0);
  });

  it("computes coverageRatio × maturity", () => {
    // chunk=10, file=20 → coverage=0.5, maturity=min(1, 10/3)=1 → alpha=0.5
    expect(computeAlpha(10, 20)).toBeCloseTo(0.5);
  });

  it("maturity dampens low-commit chunks", () => {
    // chunk=2, file=20 → coverage=0.1, maturity=min(1, 2/3)=0.667 → alpha=0.0667
    expect(computeAlpha(2, 20)).toBeCloseTo(0.0667, 3);
  });

  it("clamps to 1", () => {
    // chunk=20, file=10 → coverage=2.0 → clamped to 1
    expect(computeAlpha(20, 10)).toBe(1);
  });

  it("uses custom maturity threshold", () => {
    // chunk=2, file=20, threshold=10 → coverage=0.1, maturity=min(1, 2/10)=0.2 → alpha=0.02
    expect(computeAlpha(2, 20, 10)).toBeCloseTo(0.02);
  });

  it("default threshold matches exported constant", () => {
    expect(DEFAULT_CHUNK_MATURITY_THRESHOLD).toBe(3);
  });
});

describe("blend", () => {
  it("blends chunk and file values by alpha", () => {
    expect(blend(0.2, 0.8, 0.5)).toBeCloseTo(0.5);
  });

  it("returns fileValue when chunkValue is undefined", () => {
    expect(blend(undefined, 0.8, 0.5)).toBe(0.8);
  });

  it("returns fileValue when alpha is 0", () => {
    expect(blend(0.2, 0.8, 0)).toBeCloseTo(0.8);
  });

  it("returns chunkValue when alpha is 1", () => {
    expect(blend(0.2, 0.8, 1)).toBeCloseTo(0.2);
  });
});

describe("confidenceDampening", () => {
  it("returns 1 when sampleCount >= threshold", () => {
    expect(confidenceDampening(10, 5)).toBe(1);
    expect(confidenceDampening(5, 5)).toBe(1);
  });

  it("returns (n/k)^2 when sampleCount < threshold", () => {
    expect(confidenceDampening(2, 10)).toBeCloseTo(0.04);
    expect(confidenceDampening(3, 6)).toBeCloseTo(0.25);
  });

  it("returns 0 when sampleCount is 0", () => {
    expect(confidenceDampening(0, 5)).toBe(0);
  });

  it("returns 1 when threshold <= 0", () => {
    expect(confidenceDampening(2, 0)).toBe(1);
    expect(confidenceDampening(2, -1)).toBe(1);
  });

  it("supports custom power", () => {
    // (2/10)^3 = 0.008
    expect(confidenceDampening(2, 10, 3)).toBeCloseTo(0.008);
  });
});
