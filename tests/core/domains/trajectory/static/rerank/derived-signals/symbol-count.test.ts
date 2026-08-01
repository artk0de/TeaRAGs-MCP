import { describe, expect, it } from "vitest";

import { SymbolCountSignal } from "../../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/symbol-count.js";

describe("SymbolCountSignal", () => {
  const signal = new SymbolCountSignal();

  it("reads fileSymbolCount and declares it as its adaptive-bound source", () => {
    expect(signal.name).toBe("symbolCount");
    expect(signal.sources).toEqual(["fileSymbolCount"]);
    expect(signal.defaultBound).toBeGreaterThan(0);
  });

  it("normalizes against the adaptive bound when one is supplied", () => {
    expect(signal.extract({ fileSymbolCount: 20 }, { bounds: { fileSymbolCount: 40 } })).toBeCloseTo(0.5, 10);
  });

  it("saturates at 1 for files at or above the bound", () => {
    expect(signal.extract({ fileSymbolCount: 40 }, { bounds: { fileSymbolCount: 40 } })).toBe(1);
    expect(signal.extract({ fileSymbolCount: 400 }, { bounds: { fileSymbolCount: 40 } })).toBe(1);
  });

  it("falls back to the default bound when no adaptive bound is available", () => {
    const bound = signal.defaultBound as number;
    expect(signal.extract({ fileSymbolCount: bound / 2 })).toBeCloseTo(0.5, 10);
  });

  it("contributes nothing — never NaN — when the payload predates the signal", () => {
    expect(signal.extract({}, { bounds: { fileSymbolCount: 40 } })).toBe(0);
    expect(signal.extract({ fileSymbolCount: undefined })).toBe(0);
    expect(signal.extract({ fileSymbolCount: "many" as unknown as number })).toBe(0);
    expect(signal.extract({ fileSymbolCount: 0 })).toBe(0);
  });

  it("ranks a symbol-heavy file above a lean one", () => {
    const ctx = { bounds: { fileSymbolCount: 60 } };
    expect(signal.extract({ fileSymbolCount: 55 }, ctx)).toBeGreaterThan(signal.extract({ fileSymbolCount: 4 }, ctx));
  });
});
