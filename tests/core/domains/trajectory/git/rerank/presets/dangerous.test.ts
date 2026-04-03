import { describe, expect, it } from "vitest";

import { DangerousPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/dangerous.js";

describe("DangerousPreset", () => {
  const preset = new DangerousPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("dangerous");
  });

  it("is available in semantic_search, hybrid_search, find_similar, and rank_chunks", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("find_similar");
    expect(preset.tools).toContain("rank_chunks");
  });

  it("uses bugFix as dominant signal", () => {
    const w = preset.weights;
    const positiveWeights = Object.entries(w).filter(([, v]) => v > 0);
    const maxWeight = Math.max(...positiveWeights.map(([, v]) => v));
    expect(w.bugFix).toBe(maxWeight);
  });

  it("includes all 5 expected signals plus blockPenalty", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("bugFix");
    expect(keys).toContain("volatility");
    expect(keys).toContain("knowledgeSilo");
    expect(keys).toContain("burstActivity");
    expect(keys).toContain("similarity");
    expect(keys).toContain("blockPenalty");
  });

  it("includes blockPenalty as negative weight", () => {
    expect(preset.weights.blockPenalty).toBeLessThan(0);
  });

  it("positive weights sum to ~1.0", () => {
    const positiveSum = Object.values(preset.weights)
      .filter((v) => v > 0)
      .reduce((a, b) => a + b, 0);
    expect(positiveSum).toBeCloseTo(1.0, 1);
  });

  it("has overlayMask with ownership-related raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("dominantAuthorPct");
    expect(preset.overlayMask.file).toContain("contributorCount");
    expect(preset.overlayMask.file).toContain("bugFixRate");
  });

  it("has chunk overlay with commit and churn signals", () => {
    expect(preset.overlayMask.chunk).toContain("commitCount");
    expect(preset.overlayMask.chunk).toContain("churnRatio");
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
  });

  it("does not set signalLevel (defaults to blended)", () => {
    expect(preset.signalLevel).toBeUndefined();
  });
});
