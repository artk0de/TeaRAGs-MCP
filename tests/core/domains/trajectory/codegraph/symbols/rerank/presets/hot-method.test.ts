import { describe, expect, it } from "vitest";

import { HotMethodPreset } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/hot-method.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/index.js";

/**
 * `hotMethod` ranks by raw incoming calls — the de-facto method-level API.
 * Its question is "how many callers break if the signature changes", which is
 * the direct counterpart to `criticalMethod`'s transitive one.
 */
describe("HotMethodPreset", () => {
  const preset = new HotMethodPreset();

  it("is named hotMethod", () => {
    expect(preset.name).toBe("hotMethod");
  });

  it("scores per method, not per file", () => {
    expect(preset.signalLevel).toBe("chunk");
  });

  it("lets raw incoming calls dominate similarity", () => {
    expect(preset.weights).toEqual({ similarity: 0.3, chunkFanIn: 0.7 });
  });

  it("keeps PageRank out of the score — that is criticalMethod's axis", () => {
    expect(preset.weights).not.toHaveProperty("pageRank");
    expect(preset.weights).not.toHaveProperty("chunkFanOut");
    expect(preset.overlayMask.chunk).toEqual([
      "codegraph.chunk.fanIn",
      "codegraph.chunk.fanOut",
      "codegraph.chunk.pageRank",
    ]);
    expect(preset.overlayMask.file).toBeUndefined();
  });

  it("is offered on the four chunk-returning tools", () => {
    expect(preset.tools).toEqual(["semantic_search", "hybrid_search", "rank_chunks", "find_similar"]);
  });

  it("carries no population filter and no grouping", () => {
    expect(preset.filter).toBeUndefined();
    expect(preset.groupBy).toBeUndefined();
  });

  it("declares no requires — trajectory registration is the gate for a pure codegraph preset", () => {
    expect((preset as { requires?: unknown }).requires).toBeUndefined();
  });

  it("is registered in CODEGRAPH_SYMBOLS_PRESETS", () => {
    expect(CODEGRAPH_SYMBOLS_PRESETS.map((p) => p.name)).toContain("hotMethod");
  });
});
