/**
 * Tests for rank_chunks scoring/overlay/filtering fixes:
 * 1. Scoring: similarity weight stripped for rank_chunks, scores use full 0-1 range
 * 2. Overlay: derived values visible in overlay
 * 3. Filtering: documentation excluded from reranked results
 */

import { describe, expect, it } from "vitest";

import { Reranker } from "../../../../src/core/domains/explore/reranker.js";
import { staticDerivedSignals } from "../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";
import { DecompositionPreset } from "../../../../src/core/domains/trajectory/static/rerank/presets/decomposition.js";

describe("rank_chunks scoring fixes", () => {
  const reranker = new Reranker(staticDerivedSignals, [new DecompositionPreset()]);

  it("supports preset+custom combo: custom weights for scoring, preset mask for overlay", () => {
    const results = [
      { score: 0, payload: { methodLines: 200, methodDensity: 80 } },
      { score: 0, payload: { methodLines: 50, methodDensity: 40 } },
    ];

    // Pass custom weights without similarity, but reference preset for overlay mask
    const ranked = reranker.rerank(
      results,
      { custom: { chunkSize: 0.667, chunkDensity: 0.333 }, preset: "decomposition" },
      "rank_chunks",
    );

    // Without this fix, similarity=0.4 weight * score=0 would cap max at 0.6
    // With fix, only chunkSize+chunkDensity contribute, scores ~0.49 for methodLines=200/bound=500
    expect(ranked[0].score).toBeGreaterThan(0.4);

    // Overlay should use preset's file mask
    expect(ranked[0].rankingOverlay?.preset).toBe("decomposition");
    expect(ranked[0].rankingOverlay).not.toHaveProperty("derived");
    expect(ranked[0].rankingOverlay?.file?.methodLines).toBeGreaterThan(0);
  });

  it("scores large methods near 1.0 when similarity is excluded", () => {
    const results = [{ score: 0, payload: { methodLines: 500, methodDensity: 120 } }];

    const ranked = reranker.rerank(results, { custom: { chunkSize: 0.667, chunkDensity: 0.333 } }, "rank_chunks");

    // With methodLines at defaultBound (500) and density at defaultBound (120),
    // both signals should be ~1.0, so score should be ~1.0
    expect(ranked[0].score).toBeGreaterThan(0.9);
  });
});

describe("overlay raw values visibility", () => {
  it("overlay includes file.methodLines when decomposition mask is applied", () => {
    // This tests the formatSearchResults metaOnly path
    // When overlay has file signals, it should be included
    const reranker = new Reranker(staticDerivedSignals, [new DecompositionPreset()]);

    const results = [{ score: 0, payload: { methodLines: 100, methodDensity: 60 } }];

    const ranked = reranker.rerank(
      results,
      { custom: { chunkSize: 0.667, chunkDensity: 0.333 }, preset: "decomposition" },
      "rank_chunks",
    );

    const overlay = ranked[0].rankingOverlay;
    expect(overlay).toBeDefined();
    expect(overlay).not.toHaveProperty("derived");
    expect(overlay?.file).toBeDefined();
    expect(overlay?.file?.methodLines).toBeGreaterThan(0);
  });
});

describe("chunkDensity requires methodLines", () => {
  it("returns 0 when methodLines is 0 (documentation/non-method chunks)", () => {
    const reranker = new Reranker(staticDerivedSignals, [new DecompositionPreset()]);

    const results = [
      { score: 0, payload: { methodDensity: 250 } }, // markdown table, no methodLines
      { score: 0, payload: { methodLines: 100, methodDensity: 60 } }, // real method
    ];

    const ranked = reranker.rerank(results, { custom: { chunkSize: 0.667, chunkDensity: 0.333 } }, "rank_chunks");

    // Markdown should score 0 (both chunkSize and chunkDensity return 0)
    const markdownResult = ranked.find((r) => !r.payload?.methodLines);
    const codeResult = ranked.find((r) => r.payload?.methodLines === 100);

    expect(markdownResult?.score).toBe(0);
    expect(codeResult?.score).toBeGreaterThan(0);
  });
});
