import { describe, expect, it } from "vitest";

import { ChunkSizeSignal } from "../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/chunk-size.js";

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
    const raw = { chunkType: "function", methodLines: 100 };
    const value = signal.extract(raw);
    // normalize(100, 500) = 0.2
    expect(value).toBeCloseTo(0.2, 5);
  });

  it("uses adaptive bound from ctx when provided", () => {
    const raw = { chunkType: "function", methodLines: 100 };
    const ctx = { bounds: { methodLines: 200 } };
    // normalize(100, 200) = 0.5
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when methodLines is missing", () => {
    expect(signal.extract({ chunkType: "function" })).toBe(0);
  });

  it("returns 0 when methodLines is 0", () => {
    expect(signal.extract({ chunkType: "function", methodLines: 0 })).toBe(0);
  });

  it("clamps to 1.0 when methodLines exceeds bound", () => {
    const raw = { chunkType: "function", methodLines: 1000 };
    // normalize(1000, 500) = min(1, 2) = 1
    expect(signal.extract(raw)).toBeCloseTo(1.0, 5);
  });

  // --- chunkType filtering ---

  it("returns 0 for class chunks", () => {
    expect(signal.extract({ chunkType: "class", methodLines: 500 })).toBe(0);
  });

  it("returns 0 for interface chunks", () => {
    expect(signal.extract({ chunkType: "interface", methodLines: 200 })).toBe(0);
  });

  it("returns 0 for block chunks", () => {
    expect(signal.extract({ chunkType: "block", methodLines: 100 })).toBe(0);
  });

  it("returns 0 when chunkType is missing", () => {
    expect(signal.extract({ methodLines: 100 })).toBe(0);
  });
});
