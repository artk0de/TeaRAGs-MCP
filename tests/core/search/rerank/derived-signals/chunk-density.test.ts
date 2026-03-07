import { describe, expect, it } from "vitest";

import { ChunkDensitySignal } from "../../../../../src/core/trajectory/static/rerank/derived-signals/chunk-density.js";

describe("ChunkDensitySignal", () => {
  const signal = new ChunkDensitySignal();

  it("has correct name and description", () => {
    expect(signal.name).toBe("chunkDensity");
    expect(signal.description).toContain("density");
  });

  it("has sources = ['methodDensity'] for adaptive bounds", () => {
    expect(signal.sources).toEqual(["methodDensity"]);
  });

  it("has defaultBound = 120", () => {
    expect(signal.defaultBound).toBe(120);
  });

  it("reads methodDensity from payload and normalizes", () => {
    // 60 chars/line, normalize(60, 120) = 0.5
    const raw = { methodDensity: 60 };
    expect(signal.extract(raw)).toBeCloseTo(0.5, 5);
  });

  it("uses adaptive bound from ctx when provided", () => {
    const raw = { methodDensity: 50 };
    const ctx = { bounds: { methodDensity: 100 } };
    // normalize(50, 100) = 0.5
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when methodDensity is missing", () => {
    expect(signal.extract({})).toBe(0);
  });

  it("returns 0 when methodDensity is 0", () => {
    expect(signal.extract({ methodDensity: 0 })).toBe(0);
  });

  it("clamps to 1.0 when methodDensity exceeds bound", () => {
    // normalize(240, 120) = min(1, 2) = 1
    expect(signal.extract({ methodDensity: 240 })).toBeCloseTo(1.0, 5);
  });

  it("always returns value in 0-1 range", () => {
    const values = [
      signal.extract({ methodDensity: 10 }),
      signal.extract({ methodDensity: 500 }),
      signal.extract({ methodDensity: 60 }),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
