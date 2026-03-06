import { describe, expect, it } from "vitest";

import { DecompositionPreset } from "../../../../../src/core/search/rerank/presets/decomposition.js";

describe("DecompositionPreset", () => {
  const preset = new DecompositionPreset();

  it("has name 'decomposition'", () => {
    expect(preset.name).toBe("decomposition");
  });

  it("supports both semantic_search and search_code tools", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("search_code");
  });

  it("has balanced weights: similarity 0.3, chunkSize 0.35, chunkDensity 0.35", () => {
    expect(preset.weights.similarity).toBe(0.3);
    expect(preset.weights.chunkSize).toBe(0.35);
    expect(preset.weights.chunkDensity).toBe(0.35);
  });

  it("weights sum to 1.0", () => {
    const sum = Object.values(preset.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("has derived overlay mask with chunkSize and chunkDensity", () => {
    expect(preset.overlayMask.derived).toContain("chunkSize");
    expect(preset.overlayMask.derived).toContain("chunkDensity");
    expect(preset.overlayMask.file).toBeUndefined();
    expect(preset.overlayMask.chunk).toBeUndefined();
  });
});
