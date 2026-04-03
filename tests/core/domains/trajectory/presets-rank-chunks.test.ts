import { describe, expect, it } from "vitest";

import { GIT_PRESETS } from "../../../../src/core/domains/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../../src/core/domains/trajectory/static/rerank/presets/index.js";

const RANK_CHUNKS_PRESETS = new Set([
  "decomposition",
  "bugHunt",
  "techDebt",
  "hotspots",
  "refactoring",
  "ownership",
  "codeReview",
  "dangerous",
]);

describe("preset tool lists", () => {
  const allPresets = [...STATIC_PRESETS, ...GIT_PRESETS];

  it("only decomposition, techDebt, hotspots, refactoring, ownership include rank_chunks", () => {
    for (const preset of allPresets) {
      if (RANK_CHUNKS_PRESETS.has(preset.name)) {
        expect(preset.tools, `${preset.name} should include rank_chunks`).toContain("rank_chunks");
      } else {
        expect(preset.tools, `${preset.name} should NOT include rank_chunks`).not.toContain("rank_chunks");
      }
    }
  });

  it("all presets with semantic_search also have hybrid_search", () => {
    for (const preset of allPresets) {
      if (preset.tools.includes("semantic_search")) {
        expect(preset.tools, `${preset.name} has semantic_search but missing hybrid_search`).toContain("hybrid_search");
      }
    }
  });
});
