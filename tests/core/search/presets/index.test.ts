import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import {
  getPresetNames,
  getPresetWeights,
  RELEVANCE_PRESETS,
  resolvePresets,
} from "../../../../src/core/search/rerank/presets/index.js";
import { OnboardingPreset } from "../../../../src/core/trajectory/git/rerank/presets/onboarding.js";
import { RecentPreset } from "../../../../src/core/trajectory/git/rerank/presets/recent.js";
import { StablePreset } from "../../../../src/core/trajectory/git/rerank/presets/stable.js";

const EMPTY_MASK = {} as const;

describe("RELEVANCE_PRESETS", () => {
  it("provides relevance for semantic_search", () => {
    expect(getPresetNames(RELEVANCE_PRESETS, "semantic_search")).toContain("relevance");
  });

  it("provides relevance for search_code", () => {
    expect(getPresetNames(RELEVANCE_PRESETS, "search_code")).toContain("relevance");
  });

  it("uses only similarity weight", () => {
    const weights = getPresetWeights(RELEVANCE_PRESETS, "relevance", "semantic_search");
    expect(weights).toEqual({ similarity: 1.0 });
  });

  it("is a single RelevancePreset instance with tools[]", () => {
    expect(RELEVANCE_PRESETS).toHaveLength(1);
    expect(RELEVANCE_PRESETS[0].tools).toEqual(["semantic_search", "search_code"]);
  });
});

describe("OnboardingPreset overlay mask", () => {
  it("includes chunk-level fields for chunk-only results", () => {
    const preset = new OnboardingPreset();
    // stability weight uses commitCount — overlay mask must include chunk.commitCount
    // so chunk-only results still show raw signal data
    expect(preset.overlayMask.chunk).toBeDefined();
    expect(preset.overlayMask.chunk).toContain("commitCount");
  });
});

describe("StablePreset — multi-signal stability ranking", () => {
  const preset = new StablePreset();

  it("uses multiple signals beyond just stability", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("similarity");
    expect(keys).toContain("stability");
    expect(keys).toContain("age");
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  it("similarity remains dominant weight", () => {
    expect(preset.weights.similarity).toBeGreaterThanOrEqual(0.4);
    const nonSimilarity = Object.entries(preset.weights)
      .filter(([k]) => k !== "similarity")
      .reduce((sum, [, v]) => sum + (v ?? 0), 0);
    expect(preset.weights.similarity).toBeGreaterThan(nonSimilarity);
  });

  it("overlay mask covers all signal sources", () => {
    // file-level: commitCount (stability), ageDays (age), churnVolatility (volatility)
    expect(preset.overlayMask.file).toContain("commitCount");
    expect(preset.overlayMask.file).toContain("ageDays");
    expect(preset.overlayMask.file).toContain("churnVolatility");
    // chunk-level mirrors
    expect(preset.overlayMask.chunk).toContain("commitCount");
    expect(preset.overlayMask.chunk).toContain("ageDays");
  });
});

describe("RecentPreset — multi-signal recency ranking", () => {
  const preset = new RecentPreset();

  it("uses multiple signals beyond just recency", () => {
    const keys = Object.keys(preset.weights);
    expect(keys).toContain("similarity");
    expect(keys).toContain("recency");
    expect(keys).toContain("burstActivity");
    expect(keys.length).toBeGreaterThanOrEqual(4);
  });

  it("similarity remains dominant weight", () => {
    expect(preset.weights.similarity).toBeGreaterThanOrEqual(0.4);
    const nonSimilarity = Object.entries(preset.weights)
      .filter(([k]) => k !== "similarity")
      .reduce((sum, [, v]) => sum + (v ?? 0), 0);
    expect(preset.weights.similarity).toBeGreaterThan(nonSimilarity);
  });

  it("overlay mask covers all signal sources", () => {
    // file-level: ageDays (recency), recencyWeightedFreq (burst), changeDensity (density)
    expect(preset.overlayMask.file).toContain("ageDays");
    expect(preset.overlayMask.file).toContain("recencyWeightedFreq");
    expect(preset.overlayMask.file).toContain("changeDensity");
    // chunk-level mirrors
    expect(preset.overlayMask.chunk).toContain("ageDays");
    expect(preset.overlayMask.chunk).toContain("recencyWeightedFreq");
  });
});

describe("resolvePresets", () => {
  const generic: RerankPreset[] = [
    {
      name: "relevance",
      description: "default",
      tools: ["semantic_search"],
      weights: { similarity: 1.0 },
      overlayMask: EMPTY_MASK,
    },
  ];
  const trajectory: RerankPreset[] = [
    {
      name: "techDebt",
      description: "debt",
      tools: ["semantic_search"],
      weights: { similarity: 0.2, age: 0.15 },
      overlayMask: EMPTY_MASK,
    },
  ];

  it("merges generic + trajectory", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetNames(resolved, "semantic_search")).toContain("relevance");
    expect(getPresetNames(resolved, "semantic_search")).toContain("techDebt");
  });

  it("composite overrides trajectory by name+tool", () => {
    const composite: RerankPreset[] = [
      {
        name: "techDebt",
        description: "overridden",
        tools: ["semantic_search"],
        weights: { similarity: 0.5 },
        overlayMask: EMPTY_MASK,
      },
    ];
    const resolved = resolvePresets(generic, trajectory, composite);
    expect(getPresetWeights(resolved, "techDebt", "semantic_search")).toEqual({ similarity: 0.5 });
  });

  it("does not mix tools", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetNames(resolved, "search_code")).not.toContain("techDebt");
  });

  it("preserves generic when trajectory has different names", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetWeights(resolved, "relevance", "semantic_search")).toEqual({ similarity: 1.0 });
  });

  it("multi-tool preset appears for both tools", () => {
    const multiTool: RerankPreset[] = [
      {
        name: "relevance",
        description: "multi",
        tools: ["semantic_search", "search_code"],
        weights: { similarity: 1.0 },
        overlayMask: EMPTY_MASK,
      },
    ];
    const resolved = resolvePresets(multiTool, trajectory, []);
    expect(getPresetNames(resolved, "semantic_search")).toContain("relevance");
    expect(getPresetNames(resolved, "search_code")).toContain("relevance");
  });

  it("deduplicates multi-tool preset in resolved array", () => {
    const multiTool: RerankPreset[] = [
      {
        name: "relevance",
        description: "multi",
        tools: ["semantic_search", "search_code"],
        weights: { similarity: 1.0 },
        overlayMask: EMPTY_MASK,
      },
    ];
    const resolved = resolvePresets(multiTool, [], []);
    expect(resolved).toHaveLength(1);
  });
});
