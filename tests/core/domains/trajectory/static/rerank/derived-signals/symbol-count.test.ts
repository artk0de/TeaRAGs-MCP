import { describe, expect, it } from "vitest";

import { SymbolCountSignal } from "../../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/symbol-count.js";

describe("SymbolCountSignal", () => {
  const signal = new SymbolCountSignal();

  it("reads fileMethodCount and declares it as its adaptive-bound source", () => {
    expect(signal.name).toBe("symbolCount");
    expect(signal.sources).toEqual(["fileMethodCount"]);
    expect(signal.defaultBound).toBeGreaterThan(0);
  });

  it("normalizes against the adaptive bound when one is supplied", () => {
    expect(signal.extract({ fileMethodCount: 20 }, { bounds: { fileMethodCount: 40 } })).toBeCloseTo(0.5, 10);
  });

  it("saturates at 1 for files at or above the bound", () => {
    expect(signal.extract({ fileMethodCount: 40 }, { bounds: { fileMethodCount: 40 } })).toBe(1);
    expect(signal.extract({ fileMethodCount: 400 }, { bounds: { fileMethodCount: 40 } })).toBe(1);
  });

  it("falls back to the default bound when no adaptive bound is available", () => {
    const bound = signal.defaultBound as number;
    expect(signal.extract({ fileMethodCount: bound / 2 })).toBeCloseTo(0.5, 10);
  });

  it("contributes nothing — never NaN — when the payload predates the signal", () => {
    expect(signal.extract({}, { bounds: { fileMethodCount: 40 } })).toBe(0);
    expect(signal.extract({ fileMethodCount: undefined })).toBe(0);
    expect(signal.extract({ fileMethodCount: "many" as unknown as number })).toBe(0);
    expect(signal.extract({ fileMethodCount: 0 })).toBe(0);
  });

  it("ranks a symbol-heavy file above a lean one", () => {
    const ctx = { bounds: { fileMethodCount: 60 } };
    expect(signal.extract({ fileMethodCount: 55 }, ctx)).toBeGreaterThan(signal.extract({ fileMethodCount: 4 }, ctx));
  });
});
