import { describe, expect, it } from "vitest";

import { ChunkDensitySignal } from "../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/chunk-density.js";

describe("ChunkDensitySignal", () => {
  const signal = new ChunkDensitySignal();

  it("returns normalized value for function chunks above size floor", () => {
    const result = signal.extract({ chunkType: "function", methodLines: 50, methodDensity: 80 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns normalized value for test chunks above size floor", () => {
    const result = signal.extract({ chunkType: "test", methodLines: 50, methodDensity: 80 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns normalized value for test_setup chunks above size floor", () => {
    const result = signal.extract({ chunkType: "test_setup", methodLines: 50, methodDensity: 80 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 for block chunks", () => {
    const result = signal.extract({ chunkType: "block", methodLines: 50, methodDensity: 80 });
    expect(result).toBe(0);
  });

  it("returns 0 when methodLines below size floor", () => {
    const result = signal.extract({ chunkType: "function", methodLines: 5, methodDensity: 80 });
    expect(result).toBe(0);
  });

  it("returns 0 when methodDensity is 0", () => {
    const result = signal.extract({ chunkType: "function", methodLines: 50, methodDensity: 0 });
    expect(result).toBe(0);
  });

  it("returns 0 when methodLines is missing", () => {
    const result = signal.extract({ chunkType: "function", methodDensity: 80 });
    expect(result).toBe(0);
  });
});
