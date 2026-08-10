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
    // Use full connectionCount (≥ FALLBACK_K) so the dampening factor is 1.0
    // and the test isolates the [0,1] clamp behavior from the confidence path.
    const fullSupport = { "codegraph.file.connectionCount": 100 };
    expect(sig.extract({ "codegraph.file.instability": 0.42, ...fullSupport }, {})).toBe(0.42);
    expect(sig.extract({ "codegraph.file.instability": 1.5, ...fullSupport }, {})).toBe(1);
    expect(sig.extract({ "codegraph.file.instability": -0.1, ...fullSupport }, {})).toBe(0);
  });

  // Score-side confidence dampening for the instability ratio. With
  // connectionCount=1 the ratio swings 0↔1 from a single edge — classic
  // small-denominator noise. `confidenceDampening(n, k) = min((n/k)^2, 1)`
  // attenuates the contribution to ranking when support is below k.
  // See `.claude/rules/signal-confidence.md` for the contract.
  it("InstabilitySignal dampens score when connectionCount is below the support threshold", () => {
    const sig = new InstabilitySignal();
    const ctx = {
      confidence: {
        support: "connectionCount",
        score: { threshold: 5, adaptivePercentile: 25 },
      },
    } as const;
    // connectionCount=1, k=5 -> dampening factor = (1/5)^2 = 0.04
    const raw = { "codegraph.file.instability": 1.0, "codegraph.file.connectionCount": 1 };
    expect(sig.extract(raw, ctx)).toBeCloseTo(0.04, 5);
  });

  it("InstabilitySignal applies no dampening when connectionCount >= threshold", () => {
    const sig = new InstabilitySignal();
    const ctx = {
      confidence: {
        support: "connectionCount",
        score: { threshold: 5, adaptivePercentile: 25 },
      },
    } as const;
    // connectionCount=10, k=5 -> (10/5)^2 clamps to 1; raw 1.0 passes through.
    const raw = { "codegraph.file.instability": 1.0, "codegraph.file.connectionCount": 10 };
    expect(sig.extract(raw, ctx)).toBe(1);
  });

  it("InstabilitySignal reads connectionCount from nested codegraph payload for dampening", () => {
    const sig = new InstabilitySignal();
    const ctx = {
      confidence: {
        support: "connectionCount",
        score: { threshold: 5 },
      },
    } as const;
    const nested = {
      codegraph: {
        symbols: {
          file: {
            instability: 1.0,
            connectionCount: 1,
          },
        },
      },
    };
    expect(sig.extract(nested, ctx)).toBeCloseTo(0.04, 5);
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

  /**
   * Chunk-scoped codegraph signals under `signalLevel: "file"`.
   *
   * There is no `codegraph.file.pageRank` / `.chunk`-equivalent at file scope —
   * the file-level codegraph signals are fanIn / fanOut / instability /
   * connectionCount / transitiveImpact. A file-aggregated result still carries a
   * `codegraph.chunk.*` block, but it belongs to that file's REPRESENTATIVE
   * chunk, so reading it at file level attributes one arbitrary method's
   * centrality to the whole file. That is worse than a dead weight: it scores on
   * noise, and the chunk overlay is dropped at file level (`skipChunk`), so it
   * scores INVISIBLY.
   *
   * Git's chunk-primary signals already refuse this — `chunkChurn` and
   * `blockPenalty` route through `payloadAlpha(payload, signalLevel)`, which is 0
   * at file scope, and `ownership` / `securityAudit` both document dropping
   * chunkChurn for exactly that reason. These three are the codegraph
   * counterpart and must answer the same way: an honest 0.
   */
  describe("chunk-scoped signals contribute 0 under signalLevel 'file'", () => {
    const representativeChunk = {
      "codegraph.chunk.fanIn": 20,
      "codegraph.chunk.fanOut": 15,
      "codegraph.chunk.pageRank": 0.005,
    };

    it("ChunkFanInSignal reads 0 at file level", () => {
      const sig = new ChunkFanInSignal();
      expect(sig.extract(representativeChunk, { bounds: { "chunk.fanIn": 40 }, signalLevel: "file" })).toBe(0);
    });

    it("ChunkFanOutSignal reads 0 at file level", () => {
      const sig = new ChunkFanOutSignal();
      expect(sig.extract(representativeChunk, { bounds: { "chunk.fanOut": 30 }, signalLevel: "file" })).toBe(0);
    });

    it("PageRankSignal reads 0 at file level", () => {
      const sig = new PageRankSignal();
      expect(sig.extract(representativeChunk, { bounds: { "chunk.pageRank": 0.01 }, signalLevel: "file" })).toBe(0);
    });

    it("all three still score normally at chunk level", () => {
      expect(
        new ChunkFanInSignal().extract(representativeChunk, {
          bounds: { "chunk.fanIn": 40 },
          signalLevel: "chunk",
        }),
      ).toBeCloseTo(0.5, 5);
      expect(
        new ChunkFanOutSignal().extract(representativeChunk, {
          bounds: { "chunk.fanOut": 30 },
          signalLevel: "chunk",
        }),
      ).toBeCloseTo(0.5, 5);
      expect(
        new PageRankSignal().extract(representativeChunk, {
          bounds: { "chunk.pageRank": 0.01 },
          signalLevel: "chunk",
        }),
      ).toBeCloseTo(0.5, 5);
    });

    it("an absent signalLevel keeps scoring — the tool default is chunk", () => {
      expect(new PageRankSignal().extract(representativeChunk, { bounds: { "chunk.pageRank": 0.01 } })).toBeCloseTo(
        0.5,
        5,
      );
    });
  });

  describe("FanOutPerLineSignal", () => {
    it("returns 0 when codegraph.file.fanOut is absent or zero", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.extract({ methodLines: 100 }, {})).toBe(0);
      expect(sig.extract({}, {})).toBe(0);
      expect(sig.extract({ "codegraph.file.fanOut": 0, methodLines: 100 }, {})).toBe(0);
    });

    it("uses methodLines as the per-line denominator: fanOut=5, methodLines=100 → 0.5", () => {
      const sig = new FanOutPerLineSignal();
      // ratio = 5 / 100 = 0.05; bound = 0.1; normalize(0.05, 0.1) = 0.5
      expect(sig.extract({ "codegraph.file.fanOut": 5, methodLines: 100 }, {})).toBeCloseTo(0.5, 5);
    });

    it("falls back to startLine/endLine span when methodLines absent", () => {
      const sig = new FanOutPerLineSignal();
      // span = 59 - 10 + 1 = 50; ratio = 5 / 50 = 0.1; normalize(0.1, 0.1) = 1.0
      expect(sig.extract({ "codegraph.file.fanOut": 5, startLine: 10, endLine: 59 }, {})).toBeCloseTo(1, 5);
    });

    it("saturates at the bound: fanOut=10, methodLines=100 → ratio 0.1 = bound → 1.0", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.extract({ "codegraph.file.fanOut": 10, methodLines: 100 }, {})).toBe(1);
    });

    it("contract: no size fields → span 1 (degenerates to raw fanOut), guarded against NaN", () => {
      const sig = new FanOutPerLineSignal();
      const result = sig.extract({ "codegraph.file.fanOut": 50 }, {});
      expect(Number.isNaN(result)).toBe(false);
      // span 1 → ratio 50 → normalize(50, 0.1) clamps to 1
      expect(result).toBe(1);
    });

    it("exposes descriptor metadata: name, sources, defaultBound", () => {
      const sig = new FanOutPerLineSignal();
      expect(sig.name).toBe("fanOutPerLine");
      expect(sig.sources).toEqual(["file.fanOut"]);
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
      expect(sig.sources).toEqual(["chunk.pageRank"]);
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
      expect(sig.sources).toEqual(["file.transitiveImpact"]);
      expect(sig.defaultBound).toBe(50);
    });
  });

  // Nested-payload regression suite (tea-rags-mcp-5ajg + tea-rags-mcp-k6xu).
  //
  // EnrichmentApplier writes codegraph signals via batchSetPayload with
  // key = "codegraph.symbols.file" / "codegraph.symbols.chunk", which Qdrant
  // interprets as a path. buildFileSignals/buildChunkSignals now write BARE
  // inner keys (tea-rags-mcp-k6xu), so the real on-disk payload looks like:
  //   { codegraph: { symbols: { file: { fanIn: 5, ... } } } }
  // mirroring git's bare-key shape. Derived signals read the bare nested form.
  describe("nested payload shape (real Qdrant write path)", () => {
    // connectionCount is always written by buildFileSignals (denom = fanIn+fanOut).
    // Set to 25 here (>> FALLBACK_K=5) so InstabilitySignal confidence dampening
    // is a no-op and the test isolates payload-shape reading from score attenuation.
    const realFilePayload = {
      codegraph: {
        symbols: {
          file: {
            fanIn: 10,
            fanOut: 15,
            instability: 0.42,
            connectionCount: 25,
            isHub: true,
            isLeaf: false,
            transitiveImpact: 25,
          },
          chunk: {
            fanIn: 20,
            fanOut: 15,
            pageRank: 0.005,
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
    expect(preset.weights.fanIn).toBe(0.15);
    expect(preset.weights.churn).toBe(0.2);
    expect(preset.weights.bugFix).toBe(0.15);
    expect(preset.weights.chunkFanIn).toBe(0.05);
  });

  /**
   * Blast radius is TRANSITIVE reach. `fanIn` counts the files that import this
   * one; `codegraph.file.transitiveImpact` counts the files that reach it at any
   * depth (reverse BFS, depth-capped at index time) — the literal definition the
   * preset is named for. `CriticalPathPreset` already argues this for its own
   * axis: "the cost of a regression is how far it propagates, not how many call
   * sites touch it directly". A preset called `blastRadius` cannot disagree with
   * that while scoring only one-hop signals.
   *
   * The transitive weight comes out of the ONE-HOP structural budget
   * (`fanIn` + `isHub` + `chunkFanIn`), never out of the process budget —
   * Yatish et al. 2020 (ICSME) puts process metrics ahead of product metrics
   * (AUC 95% vs 54%) and that ordering is what the existing docblock cites.
   */
  describe("BlastRadiusPreset ranks by transitive reach, not one-hop fan-in", () => {
    const preset = new BlastRadiusPreset();
    const CODEGRAPH_SIGNAL_NAMES = new Set(CODEGRAPH_SYMBOLS_DERIVED_SIGNALS.map((s) => s.name));
    const STRUCTURAL_KEYS = ["transitiveImpact", "fanIn", "isHub", "chunkFanIn"] as const;
    const PROCESS_KEYS = ["churn", "bugFix"] as const;
    const total = (keys: readonly string[]): number =>
      keys.reduce((acc, k) => acc + Math.abs(preset.weights[k as keyof typeof preset.weights] ?? 0), 0);

    it("weights transitiveImpact — the signal that literally counts blast radius", () => {
      expect(preset.weights.transitiveImpact).toBe(0.2);
    });

    it("funds the transitive weight from the one-hop budget, leaving the process budget intact", () => {
      // churn 0.2 + bugFix 0.15 — same 0.35 the Yatish-aligned retune set.
      expect(total(PROCESS_KEYS)).toBeCloseTo(0.35, 6);
      // 0.45 structural total unchanged: transitiveImpact 0.2 is paid for by
      // fanIn 0.3 -> 0.15 and isHub 0.1 -> 0.05.
      expect(total(STRUCTURAL_KEYS)).toBeCloseTo(0.45, 6);
      expect(preset.weights.fanIn).toBe(0.15);
      expect(preset.weights.isHub).toBe(0.05);
    });

    it("keeps every product metric at or below the leading process metric", () => {
      const leadingProcess = Math.max(...PROCESS_KEYS.map((k) => preset.weights[k] ?? 0));
      for (const key of STRUCTURAL_KEYS) {
        expect(preset.weights[key] ?? 0).toBeLessThanOrEqual(leadingProcess);
      }
    });

    it("holds the preset-invariant contract: sum 1.0, similarity >= 0.2, no weight > 0.5", () => {
      const sum = Object.values(preset.weights).reduce((a, b) => a + Math.abs(b ?? 0), 0);
      expect(sum).toBeCloseTo(1.0, 6);
      expect(preset.weights.similarity ?? 0).toBeGreaterThanOrEqual(0.2);
      for (const w of Object.values(preset.weights)) {
        expect(Math.abs(w ?? 0)).toBeLessThanOrEqual(0.5);
      }
    });

    it("names only registered codegraph derived signals in its structural weights", () => {
      for (const key of STRUCTURAL_KEYS) {
        expect(CODEGRAPH_SIGNAL_NAMES.has(key)).toBe(true);
        expect(preset.weights).toHaveProperty(key);
      }
    });

    /**
     * `pageRank` is the method-level analogue and stays out: it reads
     * `codegraph.chunk.pageRank`, a representative chunk's centrality, which
     * says nothing about the file's reach. This is the same mistake `ownership`
     * and `securityAudit` document backing out of ("chunkChurn dropped —
     * signalLevel 'file' -> payloadAlpha 0 -> always-0 dead weight").
     */
    it("refuses pageRank — a chunk-scoped signal has no place in the file-shaped reach axis", () => {
      expect(preset.weights).not.toHaveProperty("pageRank");
    });

    it("surfaces the raw transitive count in the file overlay", () => {
      expect(preset.overlayMask.file).toContain("codegraph.file.transitiveImpact");
    });
  });
});
