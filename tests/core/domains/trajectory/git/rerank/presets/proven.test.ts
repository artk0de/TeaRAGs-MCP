import { describe, expect, it } from "vitest";

import { ProvenPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/proven.js";

describe("ProvenPreset", () => {
  const preset = new ProvenPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("proven");
  });

  it("is available in semantic_search, hybrid_search, search_code, and find_similar", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("search_code");
    // find_similar is required so extract-project-patterns can pass rerank="proven"
    // through find_similar (chunk-based template lookup).
    expect(preset.tools).toContain("find_similar");
    expect(preset.tools).toHaveLength(4);
  });

  it("uses all 6 expected weight keys", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("similarity");
    expect(keys).toContain("stability");
    expect(keys).toContain("age");
    expect(keys).toContain("bugFix");
    // knowledgeSilo replaces ownership: more direct measure of "few people = less peer review"
    expect(keys).toContain("knowledgeSilo");
    expect(keys).toContain("volatility");
    expect(keys).toHaveLength(6);
  });

  it("weights stability and age as strongest non-similarity signals", () => {
    const w = preset.weights;
    expect(w.stability).toBe(0.3);
    expect(w.age).toBe(0.3);
    expect(w.similarity).toBe(0.2);
  });

  it("penalizes bugFix, knowledgeSilo, and volatility", () => {
    const w = preset.weights;
    expect(w.bugFix).toBeLessThan(0);
    expect(w.knowledgeSilo).toBeLessThan(0);
    expect(w.volatility).toBeLessThan(0);
  });

  it("has overlayMask exposing the signals driving the score", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("ageDays");
    expect(preset.overlayMask.file).toContain("commitCount");
    // blameContributorCount is the source of knowledgeSilo
    expect(preset.overlayMask.file).toContain("blameContributorCount");
  });

  it("has signalLevel file", () => {
    expect(preset.signalLevel).toBe("file");
  });
});
