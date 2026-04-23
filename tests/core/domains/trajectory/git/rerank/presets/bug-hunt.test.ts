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

  it("uses all 6 expected signals", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("similarity");
    expect(keys).toContain("burstActivity");
    expect(keys).toContain("volatility");
    expect(keys).toContain("relativeChurnNorm");
    expect(keys).toContain("bugFix");
    expect(keys).toContain("recency");
  });

  it("weights burstActivity and volatility as strongest non-similarity signals", () => {
    const w = preset.weights;
    expect(w.burstActivity).toBeGreaterThanOrEqual(w.relativeChurnNorm!);
    expect(w.volatility).toBeGreaterThanOrEqual(w.relativeChurnNorm!);
  });

  it("includes blockPenalty as negative weight", () => {
    expect(preset.weights.blockPenalty).toBeLessThan(0);
  });

  it("has overlayMask with relevant raw signals", () => {
    expect(preset.overlayMask).toBeDefined();
    expect(preset.overlayMask.file).toContain("bugFixRate");
    expect(preset.overlayMask.file).toContain("churnVolatility");
    expect(preset.overlayMask.file).toContain("recencyWeightedFreq");
  });

  it("surfaces pair-diagnostic disambiguators for architectural interpretation", () => {
    // imports: separates coupling point from bug attractor (high fan-in vs low)
    expect(preset.overlayMask.file).toContain("imports");
    // dominantAuthorPct + contributorCount: separates toxic silo from healthy owner
    expect(preset.overlayMask.file).toContain("dominantAuthorPct");
    expect(preset.overlayMask.file).toContain("contributorCount");
  });

  it("surfaces method-level (chunk) disambiguators", () => {
    // chunk.bugFixRate: local method as bug source vs healthy method in buggy file
    expect(preset.overlayMask.chunk).toContain("bugFixRate");
    // chunk.ageDays: young method in old file vs ancient fossil method
    expect(preset.overlayMask.chunk).toContain("ageDays");
    // chunk.relativeChurn: method-level thrashing normalized by chunk size
    expect(preset.overlayMask.chunk).toContain("relativeChurn");
    // chunk.contributorCount: shared method inside owned file
    expect(preset.overlayMask.chunk).toContain("contributorCount");
  });

  it("does not set signalLevel (defaults to chunk)", () => {
    expect(preset.signalLevel).toBeUndefined();
  });
});
