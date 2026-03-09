import { describe, expect, it } from "vitest";

import type { ExtractContext } from "../../../../../src/core/contracts/types/trajectory.js";
import { ChunkDensitySignal } from "../../../../../src/core/trajectory/static/rerank/derived-signals/chunk-density.js";

/** Helper: build ExtractContext with collection-level p50 for methodLines */
function ctxWithP50(p50: number, densityBound?: number): ExtractContext {
  const perSignal = new Map();
  perSignal.set("methodLines", { count: 100, percentiles: { 50: p50, 95: p50 * 2 } });
  return {
    bounds: densityBound ? { methodDensity: densityBound } : undefined,
    collectionStats: { perSignal, computedAt: Date.now() },
  };
}

describe("ChunkDensitySignal", () => {
  const signal = new ChunkDensitySignal();

  it("has correct name and description", () => {
    expect(signal.name).toBe("chunkDensity");
    expect(signal.description).toContain("density");
  });

  it("has sources = ['methodDensity', 'methodLines'] for adaptive bounds", () => {
    expect(signal.sources).toEqual(["methodDensity", "methodLines"]);
  });

  it("has defaultBound = 120", () => {
    expect(signal.defaultBound).toBe(120);
  });

  it("reads methodDensity from payload and normalizes", () => {
    // 60 chars/line, normalize(60, 120) = 0.5
    const raw = { methodLines: 100, methodDensity: 60 };
    expect(signal.extract(raw)).toBeCloseTo(0.5, 5);
  });

  it("uses adaptive bound from ctx when provided", () => {
    const raw = { methodLines: 100, methodDensity: 50 };
    const ctx = { bounds: { methodDensity: 100 } };
    // normalize(50, 100) = 0.5
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when methodDensity is missing", () => {
    expect(signal.extract({ methodLines: 100 })).toBe(0);
  });

  it("returns 0 when methodDensity is 0", () => {
    expect(signal.extract({ methodLines: 100, methodDensity: 0 })).toBe(0);
  });

  it("returns 0 when methodLines is missing (non-method chunks like docs)", () => {
    expect(signal.extract({ methodDensity: 240 })).toBe(0);
  });

  it("returns 0 when methodLines is 0", () => {
    expect(signal.extract({ methodLines: 0, methodDensity: 60 })).toBe(0);
  });

  it("clamps to 1.0 when methodDensity exceeds bound", () => {
    // normalize(240, 120) = min(1, 2) = 1
    expect(signal.extract({ methodLines: 100, methodDensity: 240 })).toBeCloseTo(1.0, 5);
  });

  // --- Adaptive size threshold ---

  it("returns 0 when methodLines below floor (20 lines) without collectionStats", () => {
    expect(signal.extract({ methodLines: 15, methodDensity: 100 })).toBe(0);
    expect(signal.extract({ methodLines: 19, methodDensity: 100 })).toBe(0);
  });

  it("returns density when methodLines at floor (20 lines) without collectionStats", () => {
    expect(signal.extract({ methodLines: 20, methodDensity: 60 })).toBeGreaterThan(0);
  });

  it("returns 0 when methodLines below p50 from collectionStats", () => {
    // p50 = 100, threshold = max(20, 100) = 100
    // methodLines=50 < 100 → return 0
    const ctx = ctxWithP50(100, 120);
    expect(signal.extract({ methodLines: 50, methodDensity: 80 }, ctx)).toBe(0);
  });

  it("returns density when methodLines above p50", () => {
    // p50 = 100, methodLines=150 > 100 → compute density
    const ctx = ctxWithP50(100, 120);
    expect(signal.extract({ methodLines: 150, methodDensity: 60 }, ctx)).toBeGreaterThan(0);
  });

  it("uses floor when p50 is smaller", () => {
    // p50 = 10, threshold = max(20, 10) = 20 (floor wins)
    const ctx = ctxWithP50(10, 120);
    expect(signal.extract({ methodLines: 18, methodDensity: 80 }, ctx)).toBe(0);
    expect(signal.extract({ methodLines: 25, methodDensity: 60 }, ctx)).toBeGreaterThan(0);
  });

  it("always returns value in 0-1 range", () => {
    const values = [
      signal.extract({ methodLines: 100, methodDensity: 10 }),
      signal.extract({ methodLines: 100, methodDensity: 500 }),
      signal.extract({ methodLines: 100, methodDensity: 60 }),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
