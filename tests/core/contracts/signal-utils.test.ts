import { describe, it, expect } from "vitest";
import { normalize, p95, computeAlpha, blend, confidenceDampening } from "../../../src/core/contracts/signal-utils.js";
import { toPhysicalPayloadKey } from "../../../src/core/contracts/signal-utils.js";

describe("normalize", () => {
  it("normalizes value within range", () => {
    expect(normalize(50, 100)).toBe(0.5);
  });
  it("clamps to 1 when value exceeds max", () => {
    expect(normalize(150, 100)).toBe(1);
  });
  it("returns 0 when max is 0", () => {
    expect(normalize(10, 0)).toBe(0);
  });
});

describe("p95", () => {
  it("returns 1 for empty array", () => {
    expect(p95([])).toBe(1);
  });
  it("returns p95 of array", () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(p95(arr)).toBeGreaterThanOrEqual(94);
  });
});

describe("computeAlpha", () => {
  it("returns 0 when chunkCount is 0", () => {
    expect(computeAlpha(0, 10)).toBe(0);
  });
  it("returns 0 when fileCount is 0", () => {
    expect(computeAlpha(5, 0)).toBe(0);
  });
  it("blends proportionally", () => {
    expect(computeAlpha(3, 3, 3)).toBe(1);
  });
});

describe("blend", () => {
  it("returns fileValue when chunkValue is undefined", () => {
    expect(blend(undefined, 0.8, 0.5)).toBe(0.8);
  });
  it("blends chunk and file values by alpha", () => {
    expect(blend(0.6, 0.4, 0.5)).toBeCloseTo(0.5);
  });
});

describe("confidenceDampening", () => {
  it("returns 1 when sampleCount >= threshold", () => {
    expect(confidenceDampening(10, 10)).toBe(1);
  });
  it("returns quadratic fraction for small samples", () => {
    expect(confidenceDampening(5, 10)).toBeCloseTo(0.25);
  });
});

describe("toPhysicalPayloadKey", () => {
  it("maps codegraph logical file key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.file.instability")).toBe("codegraph.symbols.file.instability");
  });
  it("maps codegraph logical chunk key to nested symbols path", () => {
    expect(toPhysicalPayloadKey("codegraph.chunk.fanIn")).toBe("codegraph.symbols.chunk.fanIn");
  });
  it("passes git keys through unchanged", () => {
    expect(toPhysicalPayloadKey("git.file.commitCount")).toBe("git.file.commitCount");
  });
  it("passes top-level static keys through unchanged", () => {
    expect(toPhysicalPayloadKey("isTest")).toBe("isTest");
  });
});
