import { describe, expect, it } from "vitest";

import { ChunkSizeSignal } from "../../../../../src/core/search/rerank/derived-signals/chunk-size.js";

describe("ChunkSizeSignal", () => {
  const signal = new ChunkSizeSignal();

  it("has correct name", () => {
    expect(signal.name).toBe("chunkSize");
  });

  it("has sources = ['methodLines'] for adaptive bounds", () => {
    expect(signal.sources).toEqual(["methodLines"]);
  });

  it("has defaultBound = 500", () => {
    expect(signal.defaultBound).toBe(500);
  });

  it("reads methodLines from payload and normalizes", () => {
    const raw = { methodLines: 100 };
    const value = signal.extract(raw);
    // normalize(100, 500) = 0.2
    expect(value).toBeCloseTo(0.2, 5);
  });

  it("uses adaptive bound from ctx when provided", () => {
    const raw = { methodLines: 100 };
    const ctx = { bounds: { methodLines: 200 } };
    // normalize(100, 200) = 0.5
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when methodLines is missing", () => {
    expect(signal.extract({})).toBe(0);
  });

  it("returns 0 when methodLines is 0", () => {
    expect(signal.extract({ methodLines: 0 })).toBe(0);
  });

  it("clamps to 1.0 when methodLines exceeds bound", () => {
    const raw = { methodLines: 1000 };
    // normalize(1000, 500) = min(1, 2) = 1
    expect(signal.extract(raw)).toBeCloseTo(1.0, 5);
  });
});
