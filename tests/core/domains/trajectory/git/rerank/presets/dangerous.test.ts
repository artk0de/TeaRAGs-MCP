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

  it("pins the backtest-calibrated weights", () => {
    expect(preset.weights).toEqual({
      bugFix: 0.25,
      churn: 0.2,
      density: 0.15,
      recency: 0.15,
      knowledgeSilo: 0.1,
      burstActivity: 0.05,
      similarity: 0.1,
      blockPenalty: -0.05,
    });
  });

  it("uses bugFix as the highest weight", () => {
    const w = preset.weights;
    const maxWeight = Math.max(...Object.values(w).filter((v): v is number => (v ?? 0) > 0));
    expect(w.bugFix).toBe(maxWeight);
  });

  it("drops volatility (redundant with churn) but keeps knowledgeSilo as a design term", () => {
    expect(preset.weights).not.toHaveProperty("volatility");
    expect(preset.weights.knowledgeSilo).toBe(0.1);
  });

  it("surfaces commitCount and changeDensity right after bugFixRate in the file overlay", () => {
    const file = preset.overlayMask.file ?? [];
    const i = file.indexOf("bugFixRate");
    expect(file.slice(i + 1, i + 3)).toEqual(["commitCount", "changeDensity"]);
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
    expect(preset.overlayMask.file).toContain("recentDominantAuthorPct");
    expect(preset.overlayMask.file).toContain("recentContributorCount");
    expect(preset.overlayMask.file).toContain("bugFixRate");
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // imports (fan-in): coupling vs bug attractor
    expect(preset.overlayMask.file).toContain("imports");
    // ageDays: young feature vs legacy minefield
    expect(preset.overlayMask.file).toContain("ageDays");
    // relativeChurn: file-size-normalized activity
    expect(preset.overlayMask.file).toContain("relativeChurn");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // bugFixRate already covered above; add age + relativeChurn + contributorCount
    expect(preset.overlayMask.chunk).toContain("ageDays");
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
    expect(preset.overlayMask.chunk).toContain("recentContributorCount");
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
