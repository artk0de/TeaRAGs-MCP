import { describe, expect, it } from "vitest";

import { Reranker } from "../../../../../../src/core/domains/explore/reranker.js";
import { staticDerivedSignals } from "../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/index.js";
import { DecompositionPreset } from "../../../../../../src/core/domains/trajectory/static/rerank/presets/decomposition.js";

describe("DecompositionPreset", () => {
  const preset = new DecompositionPreset();

  it("has name 'decomposition'", () => {
    expect(preset.name).toBe("decomposition");
  });

  it("supports semantic_search, hybrid_search, and rank_chunks tools", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
    expect(preset.tools).toContain("rank_chunks");
    expect(preset.tools).not.toContain("search_code");
  });

  it("has weights: similarity 0.4, chunkSize 0.4, chunkDensity 0.2", () => {
    expect(preset.weights.similarity).toBe(0.4);
    expect(preset.weights.chunkSize).toBe(0.4);
    expect(preset.weights.chunkDensity).toBe(0.2);
  });

  it("weights sum to 1.0", () => {
    const sum = Object.values(preset.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("has file overlay mask with methodLines", () => {
    expect(preset.overlayMask.file).toContain("methodLines");
    expect(preset.overlayMask.chunk).toBeUndefined();
  });
});

describe("Decomposition reranking produces scores in 0-1", () => {
  const reranker = new Reranker(staticDerivedSignals, [new DecompositionPreset()]);

  it("scores large dense methods higher than small sparse ones", () => {
    const results = [
      { score: 0.8, payload: { methodLines: 200, methodDensity: 80 } },
      { score: 0.9, payload: { methodLines: 10, methodDensity: 30 } },
    ];

    const ranked = reranker.rerank(results, "decomposition", "semantic_search");

    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // Large dense method should rank first despite lower similarity
    expect(ranked[0].payload?.methodLines).toBe(200);
  });

  it("split sub-chunks with same methodLines/methodDensity score equally on size/density", () => {
    const results = [
      { score: 0.8, payload: { methodLines: 100, methodDensity: 60, startLine: 10, endLine: 50 } },
      { score: 0.8, payload: { methodLines: 100, methodDensity: 60, startLine: 51, endLine: 110 } },
    ];

    const ranked = reranker.rerank(results, "decomposition", "semantic_search");

    // Both should have identical scores (same methodLines, same methodDensity, same similarity)
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 5);
  });

  it("ranking overlay includes file.methodLines raw value", () => {
    const results = [{ score: 0.8, payload: { methodLines: 100, methodDensity: 60 } }];

    const ranked = reranker.rerank(results, "decomposition", "semantic_search");
    const overlay = ranked[0].rankingOverlay;

    expect(overlay).toBeDefined();
    expect(overlay?.preset).toBe("decomposition");
    expect(overlay).not.toHaveProperty("derived");
    expect(overlay?.file?.methodLines).toBeGreaterThan(0);
  });
});
