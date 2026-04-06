import { describe, expect, it } from "vitest";

import { ProvenPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/proven.js";

describe("ProvenPreset", () => {
  const preset = new ProvenPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("proven");
  });

  it("is available in semantic_search, hybrid_search, and search_code", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("search_code");
    expect(preset.tools).toHaveLength(3);
  });

  it("uses all 6 expected weight keys", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("similarity");
    expect(keys).toContain("stability");
    expect(keys).toContain("age");
    expect(keys).toContain("bugFix");
    expect(keys).toContain("ownership");
    expect(keys).toContain("volatility");
    expect(keys).toHaveLength(6);
  });

  it("weights stability and age as strongest non-similarity signals", () => {
    const w = preset.weights;
    expect(w.stability).toBe(0.3);
    expect(w.age).toBe(0.3);
    expect(w.similarity).toBe(0.2);
  });

  it("penalizes bugFix, ownership, and volatility", () => {
    const w = preset.weights;
    expect(w.bugFix).toBeLessThan(0);
    expect(w.ownership).toBeLessThan(0);
    expect(w.volatility).toBeLessThan(0);
  });

  it("has overlayMask with relevant raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("ageDays");
    expect(preset.overlayMask.file).toContain("commitCount");
    expect(preset.overlayMask.file).toContain("dominantAuthorPct");
  });

  it("has signalLevel file", () => {
    expect(preset.signalLevel).toBe("file");
  });
});
