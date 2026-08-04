import { describe, expect, it } from "vitest";

import { CriticalMethodPreset } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/critical-method.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/index.js";

/**
 * `criticalMethod` ranks by transitive importance — PageRank over the method
 * call graph. It answers "how deep does a change ripple", which is a different
 * question from `hotMethod`'s "how many callers break".
 */
describe("CriticalMethodPreset", () => {
  const preset = new CriticalMethodPreset();

  it("is named criticalMethod", () => {
    expect(preset.name).toBe("criticalMethod");
  });

  it("scores per method, not per file", () => {
    expect(preset.signalLevel).toBe("chunk");
  });

  it("lets PageRank dominate similarity", () => {
    expect(preset.weights).toEqual({ similarity: 0.3, pageRank: 0.7 });
  });

  it("keeps the direct-call signals out of the score and in the overlay", () => {
    expect(preset.weights).not.toHaveProperty("chunkFanIn");
    expect(preset.weights).not.toHaveProperty("chunkFanOut");
    expect(preset.overlayMask.chunk).toEqual([
      "codegraph.chunk.pageRank",
      "codegraph.chunk.fanIn",
      "codegraph.chunk.fanOut",
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

  it("describes what it ranks", () => {
    expect(preset.description).toBeTypeOf("string");
    expect(preset.description.length).toBeGreaterThan(0);
  });

  it("is registered in CODEGRAPH_SYMBOLS_PRESETS", () => {
    expect(CODEGRAPH_SYMBOLS_PRESETS.map((p) => p.name)).toContain("criticalMethod");
  });
});
