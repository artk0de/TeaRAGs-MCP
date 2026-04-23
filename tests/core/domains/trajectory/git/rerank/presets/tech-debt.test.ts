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
    expect(preset.overlayMask.file).toContain("churnVolatility");
    expect(preset.overlayMask.file).toContain("changeDensity");
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // imports: local tech debt vs coupling point
    expect(preset.overlayMask.file).toContain("imports");
    // ownership pair: moribund code with single owner vs healthy stewardship
    expect(preset.overlayMask.file).toContain("dominantAuthorPct");
    expect(preset.overlayMask.file).toContain("contributorCount");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // method-level age/churn/fix: which methods inside the old file are the actual debt
    expect(preset.overlayMask.chunk).toContain("ageDays");
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
  });
});
