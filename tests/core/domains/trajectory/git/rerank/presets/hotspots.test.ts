import { describe, expect, it } from "vitest";

import { HotspotsPreset } from "../../../../../../../src/core/domains/trajectory/git/rerank/presets/hotspots.js";

describe("HotspotsPreset", () => {
  const preset = new HotspotsPreset();

  it("has correct name", () => {
    expect(preset.name).toBe("hotspots");
  });

  it("has overlayMask with churn-related raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("churnVolatility");
    expect(preset.overlayMask.file).toContain("recencyWeightedFreq");
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // ageDays: inverts churn meaning (young = feature, old = minefield)
    expect(preset.overlayMask.file).toContain("ageDays");
    // imports: coupling point vs isolated hotspot
    expect(preset.overlayMask.file).toContain("imports");
    // ownership pair: silo vs shared infra
    expect(preset.overlayMask.file).toContain("dominantAuthorPct");
    expect(preset.overlayMask.file).toContain("contributorCount");
    // relativeChurn: size-normalized activity
    expect(preset.overlayMask.file).toContain("relativeChurn");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // chunk-level hotspot location (which method inside the file)
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
    expect(preset.overlayMask.chunk).toContain("ageDays");
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
    expect(preset.overlayMask.chunk).toContain("contributorCount");
  });
});
