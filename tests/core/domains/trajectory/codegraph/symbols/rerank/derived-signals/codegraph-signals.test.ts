import { describe, expect, it } from "vitest";

import {
  ChunkFanInSignal,
  ChunkFanOutSignal,
  CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
  FanInSignal,
  FanOutPerLineSignal,
  FanOutSignal,
  InstabilitySignal,
  IsHubSignal,
  IsLeafSignal,
  PageRankSignal,
  TransitiveImpactSignal,
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

  // Defensive guard against a payload value that can't be coerced to a
  // number (e.g. stale schema or corrupt point). `Number("not-a-number")`
  // yields NaN; the signal short-circuits to 0 rather than propagating a
  // poisoned score through normalization.
  it("InstabilitySignal returns 0 when raw value is non-numeric (NaN)", () => {
    const sig = new InstabilitySignal();
    expect(sig.extract({ "codegraph.file.instability": "not-a-number" }, {})).toBe(0);
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

  describe("FanOutPerLineSignal", () => {
    it("returns 0 when codegraph.file.fanOut is absent", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.extract({ chunkSize: 100 }, {})).toBe(0);
    });

    it("returns 0 when fanOut is 0 with implicit chunkSize=1", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.extract({}, {})).toBe(0);
      expect(sig.extract({ "codegraph.file.fanOut": 0 }, {})).toBe(0);
    });

    it("normalises fanOut=10, chunkSize=100 against default bound 0.1 to clamp at 1.0", () => {
      const sig = new FanOutPerLineSignal();
      // ratio = 10 / 100 = 0.1; bound = 0.1; normalize(0.1, 0.1) = 1.0
      expect(sig.extract({ "codegraph.file.fanOut": 10, chunkSize: 100 }, {})).toBe(1);
    });

    it("normalises a mid-range value against default bound 0.1", () => {
      const sig = new FanOutPerLineSignal();
      // ratio = 5 / 100 = 0.05; bound = 0.1; normalize(0.05, 0.1) = 0.5
      expect(sig.extract({ "codegraph.file.fanOut": 5, chunkSize: 100 }, {})).toBeCloseTo(0.5, 5);
    });

    it("respects ctx.bounds['chunk.fanOutPerLine'] override over the default bound", () => {
      const sig = new FanOutPerLineSignal();
      // ratio = 10 / 100 = 0.1; override bound = 0.2; normalize(0.1, 0.2) = 0.5
      expect(
        sig.extract({ "codegraph.file.fanOut": 10, chunkSize: 100 }, { bounds: { "chunk.fanOutPerLine": 0.2 } }),
      ).toBeCloseTo(0.5, 5);
    });

    it("guards chunkSize=0 via Math.max so fanOut/0 does not produce NaN", () => {
      const sig = new FanOutPerLineSignal();
      // size guarded to 1; ratio = 50 / 1 = 50; normalize(50, 0.1) clamps to 1
      const result = sig.extract({ "codegraph.file.fanOut": 50, chunkSize: 0 }, {});
      expect(Number.isNaN(result)).toBe(false);
      expect(result).toBe(1);
    });

    it("exposes descriptor metadata: name, sources, defaultBound", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.name).toBe("fanOutPerLine");
      expect(sig.sources).toEqual(["codegraph.file.fanOut"]);
      expect(sig.defaultBound).toBe(0.1);
    });
  });

  describe("PageRankSignal", () => {
    it("normalizes codegraph.chunk.pageRank against default bound 0.01", () => {
      const sig = new PageRankSignal();
      // raw=0.005, default bound=0.01, normalize -> 0.5
      expect(sig.extract({ "codegraph.chunk.pageRank": 0.005 }, {})).toBeCloseTo(0.5, 5);
    });

    it("returns 0 when codegraph.chunk.pageRank is absent", () => {
      const sig = new PageRankSignal();
      expect(sig.extract({}, {})).toBe(0);
    });

    it("respects ctx.bounds['chunk.pageRank'] override over the default bound", () => {
      const sig = new PageRankSignal();
      // raw=0.01, override bound=0.02 -> 0.5
      expect(sig.extract({ "codegraph.chunk.pageRank": 0.01 }, { bounds: { "chunk.pageRank": 0.02 } })).toBeCloseTo(
        0.5,
        5,
      );
    });

    it("exposes descriptor metadata: name, sources, defaultBound", () => {
      const sig = new PageRankSignal();
      expect(sig.name).toBe("pageRank");
      expect(sig.sources).toEqual(["codegraph.chunk.pageRank"]);
      expect(sig.defaultBound).toBe(0.01);
    });
  });

  describe("TransitiveImpactSignal", () => {
    it("normalizes codegraph.file.transitiveImpact against default bound 50", () => {
      const sig = new TransitiveImpactSignal();
      // raw=25, default bound=50, normalize -> 0.5
      expect(sig.extract({ "codegraph.file.transitiveImpact": 25 }, {})).toBeCloseTo(0.5, 5);
    });

    it("returns 0 when codegraph.file.transitiveImpact is absent", () => {
      const sig = new TransitiveImpactSignal();
      expect(sig.extract({}, {})).toBe(0);
    });

    it("respects ctx.bounds['file.transitiveImpact'] override", () => {
      const sig = new TransitiveImpactSignal();
      // raw=60, override bound=120 -> 0.5
      expect(
        sig.extract({ "codegraph.file.transitiveImpact": 60 }, { bounds: { "file.transitiveImpact": 120 } }),
      ).toBeCloseTo(0.5, 5);
    });

    it("clamps to 1.0 when raw exceeds bound", () => {
      const sig = new TransitiveImpactSignal();
      expect(sig.extract({ "codegraph.file.transitiveImpact": 100 }, { bounds: { "file.transitiveImpact": 50 } })).toBe(
        1,
      );
    });

    it("exposes descriptor metadata: name, sources, defaultBound", () => {
      const sig = new TransitiveImpactSignal();
      expect(sig.name).toBe("transitiveImpact");
      expect(sig.sources).toEqual(["codegraph.file.transitiveImpact"]);
      expect(sig.defaultBound).toBe(50);
    });
  });

  // Nested-payload regression suite (tea-rags-mcp-5ajg).
  //
  // EnrichmentApplier writes codegraph signals via batchSetPayload with
  // key = "codegraph.symbols.file" / "codegraph.symbols.chunk", which Qdrant
  // interprets as a path. Inner keys keep their literal dotted form, so the
  // real on-disk payload looks like:
  //   { codegraph: { symbols: { file: { "codegraph.file.fanIn": 5, ... } } } }
  // Before the helper migration, derived signals read raw["codegraph.file.X"]
  // at the root of the payload — always undefined → scored 0 in production.
  describe("nested payload shape (real Qdrant write path)", () => {
    const realFilePayload = {
      codegraph: {
        symbols: {
          file: {
            "codegraph.file.fanIn": 10,
            "codegraph.file.fanOut": 15,
            "codegraph.file.instability": 0.42,
            "codegraph.file.isHub": true,
            "codegraph.file.isLeaf": false,
            "codegraph.file.transitiveImpact": 25,
          },
          chunk: {
            "codegraph.chunk.fanIn": 20,
            "codegraph.chunk.fanOut": 15,
            "codegraph.chunk.pageRank": 0.005,
          },
        },
      },
      chunkSize: 100,
    };

    it("FanInSignal reads nested codegraph.symbols.file payload", () => {
      const sig = new FanInSignal();
      expect(sig.extract(realFilePayload, { bounds: { "file.fanIn": 20 } })).toBeCloseTo(0.5, 5);
    });

    it("FanOutSignal reads nested codegraph.symbols.file payload", () => {
      const sig = new FanOutSignal();
      expect(sig.extract(realFilePayload, { bounds: { "file.fanOut": 30 } })).toBeCloseTo(0.5, 5);
    });

    it("InstabilitySignal reads nested codegraph.symbols.file payload", () => {
      const sig = new InstabilitySignal();
      expect(sig.extract(realFilePayload, {})).toBe(0.42);
    });

    it("IsHubSignal reads nested codegraph.symbols.file payload", () => {
      const sig = new IsHubSignal();
      expect(sig.extract(realFilePayload, {})).toBe(1);
    });

    it("IsLeafSignal reads nested codegraph.symbols.file payload", () => {
      const sig = new IsLeafSignal();
      expect(sig.extract(realFilePayload, {})).toBe(0);
    });

    it("TransitiveImpactSignal reads nested codegraph.symbols.file payload", () => {
      const sig = new TransitiveImpactSignal();
      expect(sig.extract(realFilePayload, {})).toBeCloseTo(0.5, 5);
    });

    it("FanOutPerLineSignal reads nested codegraph.symbols.file payload and root chunkSize", () => {
      const sig = new FanOutPerLineSignal();
      // fanOut=15, chunkSize=100, ratio=0.15, defaultBound=0.1 → clamped to 1
      expect(sig.extract(realFilePayload, {})).toBe(1);
    });

    it("ChunkFanInSignal reads nested codegraph.symbols.chunk payload", () => {
      const sig = new ChunkFanInSignal();
      expect(sig.extract(realFilePayload, { bounds: { "chunk.fanIn": 40 } })).toBeCloseTo(0.5, 5);
    });

    it("ChunkFanOutSignal reads nested codegraph.symbols.chunk payload", () => {
      const sig = new ChunkFanOutSignal();
      expect(sig.extract(realFilePayload, { bounds: { "chunk.fanOut": 30 } })).toBeCloseTo(0.5, 5);
    });

    it("PageRankSignal reads nested codegraph.symbols.chunk payload", () => {
      const sig = new PageRankSignal();
      expect(sig.extract(realFilePayload, {})).toBeCloseTo(0.5, 5);
    });
  });

  it("CODEGRAPH_SYMBOLS_DERIVED_SIGNALS contains all 10 signals (Slice 2 adds transitiveImpact + pageRank + fanOutPerLine)", () => {
    expect(CODEGRAPH_SYMBOLS_DERIVED_SIGNALS.map((s) => s.name).sort()).toEqual([
      "chunkFanIn",
      "chunkFanOut",
      "fanIn",
      "fanOut",
      "fanOutPerLine",
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
