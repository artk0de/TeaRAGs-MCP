import { describe, expect, it } from "vitest";

import {
  ChunkFanInSignal,
  ChunkFanOutSignal,
  CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
  FanInSignal,
  FanOutSignal,
  InstabilitySignal,
  IsHubSignal,
  IsLeafSignal,
} from "../../../../../../../../src/core/domains/trajectory/codegraph/symbols/rerank/derived-signals/index.js";
import { BlastRadiusPreset } from "../../../../../../../../src/core/domains/trajectory/composite/presets/blast-radius.js";

describe("codegraph derived signals", () => {
  it("FanInSignal normalizes codegraph.file.fanIn against bounds", () => {
    const sig = new FanInSignal();
    expect(sig.extract({ "codegraph.file.fanIn": 10 }, { bounds: { "file.fanIn": 20 } })).toBeCloseTo(0.5, 5);
    expect(sig.extract({}, {})).toBe(0);
  });

  it("FanOutSignal normalizes codegraph.file.fanOut against bounds", () => {
    const sig = new FanOutSignal();
    expect(sig.extract({ "codegraph.file.fanOut": 15 }, { bounds: { "file.fanOut": 30 } })).toBeCloseTo(0.5, 5);
  });

  it("InstabilitySignal passes through raw value clamped to [0,1]", () => {
    const sig = new InstabilitySignal();
    expect(sig.extract({ "codegraph.file.instability": 0.42 }, {})).toBe(0.42);
    expect(sig.extract({ "codegraph.file.instability": 1.5 }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.instability": -0.1 }, {})).toBe(0);
  });

  it("IsHubSignal returns 1 when raw boolean is true", () => {
    const sig = new IsHubSignal();
    expect(sig.extract({ "codegraph.file.isHub": true }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.isHub": false }, {})).toBe(0);
  });

  it("IsLeafSignal returns 1 when raw boolean is true", () => {
    const sig = new IsLeafSignal();
    expect(sig.extract({ "codegraph.file.isLeaf": true }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.isLeaf": false }, {})).toBe(0);
  });

  it("ChunkFanInSignal normalizes codegraph.chunk.fanIn against bounds", () => {
    const sig = new ChunkFanInSignal();
    expect(sig.extract({ "codegraph.chunk.fanIn": 20 }, { bounds: { "chunk.fanIn": 40 } })).toBeCloseTo(0.5, 5);
  });

  it("ChunkFanOutSignal normalizes codegraph.chunk.fanOut against bounds", () => {
    const sig = new ChunkFanOutSignal();
    expect(sig.extract({ "codegraph.chunk.fanOut": 15 }, { bounds: { "chunk.fanOut": 30 } })).toBeCloseTo(0.5, 5);
  });

  it("CODEGRAPH_SYMBOLS_DERIVED_SIGNALS contains all 9 signals (Slice 2 adds transitiveImpact + pageRank)", () => {
    expect(CODEGRAPH_SYMBOLS_DERIVED_SIGNALS.map((s) => s.name).sort()).toEqual([
      "chunkFanIn",
      "chunkFanOut",
      "fanIn",
      "fanOut",
      "instability",
      "isHub",
      "isLeaf",
      "pageRank",
      "transitiveImpact",
    ]);
  });

  it("BlastRadiusPreset is registered for semantic_search/hybrid_search/rank_chunks", () => {
    // BlastRadiusPreset lives in `domains/trajectory/composite/presets/`
    // (mixes codegraph + git signals); weights retuned per Yatish 2020
    // process-domination during Slice 2 reclassification.
    const preset = new BlastRadiusPreset();
    expect(preset.name).toBe("blastRadius");
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("rank_chunks");
    expect(preset.weights.similarity).toBe(0.2);
    expect(preset.weights.fanIn).toBe(0.3);
    expect(preset.weights.churn).toBe(0.2);
    expect(preset.weights.bugFix).toBe(0.15);
    expect(preset.weights.chunkFanIn).toBe(0.05);
  });
});
