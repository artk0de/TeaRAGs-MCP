import { describe, expect, it } from "vitest";

import { TechDebtPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/tech-debt.js";

describe("TechDebtPreset", () => {
  const preset = new TechDebtPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("techDebt");
  });

  it("has overlayMask with age-related raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("ageDays");
    expect(preset.overlayMask.file).toContain("commitCount");
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("recencyWeightedFreq");
    expect(preset.overlayMask.file).toContain("relativeChurn");
    expect(preset.overlayMask.file).not.toContain("churnVolatility");
    expect(preset.overlayMask.file).not.toContain("changeDensity");
  });

  it("pins the backtest-calibrated weights, age held at 0.15", () => {
    expect(preset.weights).toEqual({
      similarity: 0.15,
      age: 0.15,
      chunkChurn: 0.3,
      burstActivity: 0.2,
      bugFix: 0.05,
      chunkRelativeChurn: 0.05,
      relativeChurnNorm: 0.05,
      blockPenalty: -0.05,
    });
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // imports: local tech debt vs coupling point
    expect(preset.overlayMask.file).toContain("imports");
    // ownership pair: moribund code with single owner vs healthy stewardship
    expect(preset.overlayMask.file).toContain("recentDominantAuthorPct");
    expect(preset.overlayMask.file).toContain("recentContributorCount");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // method-level age/churn/fix: which methods inside the old file are the actual debt
    expect(preset.overlayMask.chunk).toContain("ageDays");
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
  });
});
