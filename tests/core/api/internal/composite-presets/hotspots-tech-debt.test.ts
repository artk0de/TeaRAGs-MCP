import { describe, expect, it } from "vitest";

import {
  HotspotsCompositePreset,
  TechDebtCompositePreset,
} from "../../../../../src/core/api/internal/composite-presets/index.js";

/**
 * The composite `hotspots` and `techDebt` keep their git presets' calibrated
 * terms scaled to the composite's git share, plus the unchanged fanIn term.
 */
describe("HotspotsCompositePreset", () => {
  const preset = new HotspotsCompositePreset();

  it("pins the weights: calibrated git terms plus unchanged fanIn", () => {
    expect(preset.weights).toEqual({
      similarity: 0.18,
      chunkSize: 0.1,
      chunkChurn: 0.37,
      chunkRelativeChurn: 0.14,
      bugFix: 0.09,
      relativeChurnNorm: 0.04,
      fanIn: 0.08,
      blockPenalty: -0.15,
    });
  });

  it("drops the timing signals from the overlay", () => {
    const file = preset.overlayMask.file ?? [];
    expect(file).toContain("commitCount");
    expect(file).toContain("codegraph.file.fanIn");
    expect(file).not.toContain("churnVolatility");
    expect(file).not.toContain("recencyWeightedFreq");
  });
});

describe("TechDebtCompositePreset", () => {
  const preset = new TechDebtCompositePreset();

  it("pins the weights: calibrated git terms plus unchanged fanIn", () => {
    expect(preset.weights).toEqual({
      similarity: 0.13,
      age: 0.14,
      chunkChurn: 0.27,
      burstActivity: 0.18,
      bugFix: 0.04,
      chunkRelativeChurn: 0.05,
      relativeChurnNorm: 0.04,
      fanIn: 0.1,
      blockPenalty: -0.05,
    });
  });

  it("drops knowledgeSilo, volatility and density", () => {
    expect(preset.weights).not.toHaveProperty("knowledgeSilo");
    expect(preset.weights).not.toHaveProperty("volatility");
    expect(preset.weights).not.toHaveProperty("density");
  });
});
