import { describe, expect, it } from "vitest";

import { BugHuntPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/bug-hunt.js";

describe("BugHuntPreset", () => {
  const preset = new BugHuntPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("bugHunt");
  });

  it("is available in semantic_search, hybrid_search, and search_code", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("search_code");
  });

  it("pins the backtest-calibrated weights exactly", () => {
    expect(preset.weights).toEqual({
      similarity: 0.25,
      churn: 0.25,
      bugFix: 0.2,
      density: 0.15,
      recency: 0.1,
      burstActivity: 0.05,
      blockPenalty: -0.05,
    });
  });

  it("weights churn and bugFix as the strongest git signals (backtest-calibrated)", () => {
    const w = preset.weights;
    expect(w.churn).toBeGreaterThanOrEqual(w.bugFix!);
    expect(w.churn).toBeGreaterThanOrEqual(w.density!);
    expect(w.churn).toBeGreaterThanOrEqual(w.recency!);
    expect(w.churn).toBeGreaterThanOrEqual(w.burstActivity!);
    expect(w.bugFix).toBeGreaterThanOrEqual(w.density!);
    expect(w.bugFix).toBeGreaterThanOrEqual(w.recency!);
    expect(w.bugFix).toBeGreaterThanOrEqual(w.burstActivity!);
  });

  it("drops volatility and relativeChurnNorm, redundant with churn in the backtest", () => {
    expect(preset.weights.volatility).toBeUndefined();
    expect(preset.weights.relativeChurnNorm).toBeUndefined();
  });

  it("includes blockPenalty as negative weight", () => {
    expect(preset.weights.blockPenalty).toBeLessThan(0);
  });

  it("has overlayMask with relevant raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("churnVolatility");
    expect(preset.overlayMask.file).toContain("recencyWeightedFreq");
    expect(preset.overlayMask.file).toContain("commitCount");
    expect(preset.overlayMask.file).toContain("changeDensity");
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // imports: separates coupling point from bug attractor (high fan-in vs low)
    expect(preset.overlayMask.file).toContain("imports");
    // recentDominantAuthorPct + recentContributorCount: separates toxic silo from healthy owner
    expect(preset.overlayMask.file).toContain("recentDominantAuthorPct");
    expect(preset.overlayMask.file).toContain("recentContributorCount");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // chunk.bugFixRate: local method as bug source vs healthy method in buggy file
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
    // chunk.ageDays: young method in old file vs ancient fossil method
    expect(preset.overlayMask.chunk).toContain("ageDays");
    // chunk.relativeChurn: method-level thrashing normalized by chunk size
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
    // chunk.recentContributorCount: shared method inside owned file
    expect(preset.overlayMask.chunk).toContain("recentContributorCount");
  });

  it("ranks at file level by default (bd tea-rags-mcp-9z8ae: backtest is file-level)", () => {
    expect(preset.signalLevel).toBe("file");
  });
});
