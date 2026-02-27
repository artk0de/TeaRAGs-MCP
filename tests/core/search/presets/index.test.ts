import { describe, expect, it } from "vitest";

import type { RerankPreset } from "../../../../src/core/contracts/types/reranker.js";
import {
  getPresetNames,
  getPresetWeights,
  RELEVANCE_PRESETS,
  resolvePresets,
} from "../../../../src/core/search/presets/index.js";

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
});

describe("resolvePresets", () => {
  const generic: RerankPreset[] = [
    { name: "relevance", description: "default", tool: "semantic_search", weights: { similarity: 1.0 } },
  ];
  const trajectory: RerankPreset[] = [
    { name: "techDebt", description: "debt", tool: "semantic_search", weights: { similarity: 0.2, age: 0.15 } },
  ];

  it("merges generic + trajectory", () => {
    const resolved = resolvePresets(generic, trajectory, []);
    expect(getPresetNames(resolved, "semantic_search")).toContain("relevance");
    expect(getPresetNames(resolved, "semantic_search")).toContain("techDebt");
  });

  it("composite overrides trajectory by name+tool", () => {
    const composite: RerankPreset[] = [
      { name: "techDebt", description: "overridden", tool: "semantic_search", weights: { similarity: 0.5 } },
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
});
