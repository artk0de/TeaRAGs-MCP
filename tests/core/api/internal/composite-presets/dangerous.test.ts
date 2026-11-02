import { describe, expect, it } from "vitest";

import { DangerousCompositePreset } from "../../../../../src/core/api/internal/composite-presets/index.js";
import type { CompositeRerankPreset } from "../../../../../src/core/contracts/types/reranker.js";
import { DangerousPreset } from "../../../../../src/core/domains/trajectory/git/rerank/presets/index.js";

/**
 * The composite `dangerous` keeps the git preset's calibrated terms (scaled to
 * 0.75) and adds one call-graph term: fanIn, uncalibrated and kept unchanged.
 */
describe("DangerousCompositePreset", () => {
  const composite: CompositeRerankPreset = new DangerousCompositePreset();
  const base = new DangerousPreset();

  it("shares the git preset's name so it overrides by (name, tool)", () => {
    expect(composite.name).toBe("dangerous");
    expect(composite.name).toBe(base.name);
  });

  it("pins the weights: calibrated git terms plus unchanged fanIn", () => {
    expect(composite.weights).toEqual({
      bugFix: 0.21,
      churn: 0.17,
      recency: 0.13,
      density: 0.12,
      knowledgeSilo: 0.08,
      burstActivity: 0.04,
      fanIn: 0.15,
      similarity: 0.1,
      blockPenalty: -0.05,
    });
  });

  it("drops volatility", () => {
    expect(composite.weights).not.toHaveProperty("volatility");
  });

  it("mirrors the git preset's commitCount and changeDensity overlay insertion", () => {
    const file = composite.overlayMask.file ?? [];
    const i = file.indexOf("bugFixRate");
    expect(file.slice(i + 1, i + 3)).toEqual(["commitCount", "changeDensity"]);
  });
});
