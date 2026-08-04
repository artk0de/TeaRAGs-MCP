import { describe, expect, it } from "vitest";

import { GodMethodPreset } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/god-method.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/presets/index.js";

/**
 * `godMethod` ranks by outgoing calls — the orchestrator that reaches for a
 * dozen collaborators. It is the mirror of `hotMethod`: same graph, opposite
 * direction, and the p95 label on `codegraph.chunk.fanOut` is literally
 * `god-method`.
 */
describe("GodMethodPreset", () => {
  const preset = new GodMethodPreset();

  it("is named godMethod", () => {
    expect(preset.name).toBe("godMethod");
  });

  it("scores per method, not per file", () => {
    expect(preset.signalLevel).toBe("chunk");
  });

  it("lets outgoing calls dominate similarity", () => {
    expect(preset.weights).toEqual({ similarity: 0.3, chunkFanOut: 0.7 });
  });

  it("scores the opposite axis from hotMethod and keeps the rest in the overlay", () => {
    expect(preset.weights).not.toHaveProperty("chunkFanIn");
    expect(preset.weights).not.toHaveProperty("pageRank");
    expect(preset.overlayMask.chunk).toEqual([
      "codegraph.chunk.fanOut",
      "codegraph.chunk.fanIn",
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
    expect(CODEGRAPH_SYMBOLS_PRESETS.map((p) => p.name)).toContain("godMethod");
  });
});
