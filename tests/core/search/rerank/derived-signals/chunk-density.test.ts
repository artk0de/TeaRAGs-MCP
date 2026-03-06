import { describe, expect, it } from "vitest";

import { ChunkDensitySignal } from "../../../../../src/core/search/rerank/derived-signals/chunk-density.js";

describe("ChunkDensitySignal", () => {
  const signal = new ChunkDensitySignal();

  it("has correct name and description", () => {
    expect(signal.name).toBe("chunkDensity");
    expect(signal.description).toContain("density");
  });

  it("has no sources (structural signal)", () => {
    expect(signal.sources).toEqual([]);
  });

  it("has defaultBound = 0 (purely adaptive p95)", () => {
    expect(signal.defaultBound).toBe(0);
  });

  it("computes chars per line from contentSize and line range", () => {
    // 100 chars across 10 lines = 10 chars/line
    const raw = { contentSize: 100, startLine: 1, endLine: 10 };
    const value = signal.extract(raw);
    // With defaultBound=0 and no ctx.bounds, normalize(10, 0) would cap.
    // But the signal should return raw density for adaptive bounds to handle.
    expect(value).toBeGreaterThan(0);
  });

  it("returns 0 when contentSize is missing", () => {
    const raw = { startLine: 1, endLine: 10 };
    expect(signal.extract(raw)).toBe(0);
  });

  it("returns 0 when lines are zero or negative", () => {
    expect(signal.extract({ contentSize: 100, startLine: 5, endLine: 5 })).toBe(0);
    expect(signal.extract({ contentSize: 100, startLine: 10, endLine: 5 })).toBe(0);
  });

  it("higher contentSize per line produces higher signal", () => {
    const sparse = signal.extract({ contentSize: 200, startLine: 1, endLine: 10 });
    const dense = signal.extract({ contentSize: 1000, startLine: 1, endLine: 10 });
    expect(dense).toBeGreaterThan(sparse);
  });

  it("uses adaptive bounds from ctx when provided", () => {
    const raw = { contentSize: 500, startLine: 1, endLine: 11 };
    // 500 / (11-1) = 50 chars/line, bound = 100 → normalized = 0.5
    const ctx = { bounds: { chunkDensity: 100 } };
    const value = signal.extract(raw, ctx);
    expect(value).toBeCloseTo(0.5, 5);
  });
});
