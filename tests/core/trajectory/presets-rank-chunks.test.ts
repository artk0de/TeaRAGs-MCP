import { describe, expect, it } from "vitest";

import { GIT_PRESETS } from "../../../src/core/trajectory/git/rerank/presets/index.js";
import { STATIC_PRESETS } from "../../../src/core/trajectory/static/rerank/presets/index.js";

describe("rank_chunks preset support", () => {
  const allPresets = [...STATIC_PRESETS, ...GIT_PRESETS];

  it("all presets include rank_chunks in tools", () => {
    for (const preset of allPresets) {
      expect(preset.tools, `${preset.name} should include rank_chunks`).toContain("rank_chunks");
    }
  });
});
