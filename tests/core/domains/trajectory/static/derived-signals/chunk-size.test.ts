import { describe, expect, it } from "vitest";

import { ChunkSizeSignal } from "../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/chunk-size.js";

describe("ChunkSizeSignal", () => {
  const signal = new ChunkSizeSignal();

  it("returns normalized value for function chunks", () => {
    const result = signal.extract({ chunkType: "function", methodLines: 100 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns normalized value for test chunks", () => {
    const result = signal.extract({ chunkType: "test", methodLines: 100 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns normalized value for test_setup chunks", () => {
    const result = signal.extract({ chunkType: "test_setup", methodLines: 100 });
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 for block chunks", () => {
    const result = signal.extract({ chunkType: "block", methodLines: 100 });
    expect(result).toBe(0);
  });

  it("returns 0 for class chunks", () => {
    const result = signal.extract({ chunkType: "class", methodLines: 100 });
    expect(result).toBe(0);
  });

  it("returns 0 for interface chunks", () => {
    const result = signal.extract({ chunkType: "interface", methodLines: 100 });
    expect(result).toBe(0);
  });

  it("returns 0 when methodLines is 0", () => {
    const result = signal.extract({ chunkType: "function", methodLines: 0 });
    expect(result).toBe(0);
  });

  it("returns 0 when methodLines is missing", () => {
    const result = signal.extract({ chunkType: "function" });
    expect(result).toBe(0);
  });

  it("uses adaptive bounds from context", () => {
    const withDefault = signal.extract({ chunkType: "function", methodLines: 100 });
    const withCustomBound = signal.extract(
      { chunkType: "function", methodLines: 100 },
      { bounds: { methodLines: 50 } },
    );
    expect(withCustomBound).toBeGreaterThan(withDefault);
  });
});
