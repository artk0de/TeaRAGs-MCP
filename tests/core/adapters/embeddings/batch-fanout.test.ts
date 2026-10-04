import { describe, expect, it } from "vitest";

import {
  EMBEDDING_MICRO_BATCHES_PER_SLOT,
  planEmbeddingMicroBatches,
} from "../../../../src/core/adapters/embeddings/batch-fanout.js";

function equalTexts(n: number, size = 10): string[] {
  return Array.from({ length: n }, () => "x".repeat(size));
}

function charTotal(texts: readonly string[], indices: readonly number[]): number {
  return indices.reduce((sum, i) => sum + texts[i].length, 0);
}

/** Every index 0..n-1 exactly once, in input order, no empty micro-batch. */
function expectContiguousCover(microBatches: number[][], n: number): void {
  expect(microBatches.flat()).toEqual(Array.from({ length: n }, (_, i) => i));
  for (const microBatch of microBatches) expect(microBatch.length).toBeGreaterThan(0);
}

describe("planEmbeddingMicroBatches", () => {
  describe("count", () => {
    it("targets EMBEDDING_MICRO_BATCHES_PER_SLOT micro-batches per slot", () => {
      expect(EMBEDDING_MICRO_BATCHES_PER_SLOT).toBe(4);
      expect(planEmbeddingMicroBatches(equalTexts(256), 8)).toHaveLength(32);
    });

    it("never plans more micro-batches than texts", () => {
      const microBatches = planEmbeddingMicroBatches(equalTexts(5), 4);
      expect(microBatches).toEqual([[0], [1], [2], [3], [4]]);
    });

    it("plans at least one micro-batch, treating fewer than one slot as one", () => {
      expect(planEmbeddingMicroBatches(equalTexts(8), 0)).toHaveLength(4);
      expect(planEmbeddingMicroBatches(equalTexts(8), 1)).toHaveLength(4);
    });
  });

  describe("shape", () => {
    it("cuts equal texts into equal contiguous micro-batches in input order", () => {
      expect(planEmbeddingMicroBatches(equalTexts(8), 1)).toEqual([
        [0, 1],
        [2, 3],
        [4, 5],
        [6, 7],
      ]);
    });

    it("cuts by characters, not by count", () => {
      const texts = ["x".repeat(900), ...Array.from({ length: 9 }, () => "y".repeat(100))];
      const microBatches = planEmbeddingMicroBatches(texts, 1);
      expect(microBatches).toHaveLength(4);
      // By count the first quarter would be 2-3 texts; by chars the 900-char text is half the batch alone.
      expect(microBatches[0]).toEqual([0]);
      expectContiguousCover(microBatches, texts.length);
    });

    it("keeps char totals near-equal over uneven text lengths", () => {
      const texts = Array.from({ length: 400 }, (_, i) => "z".repeat(1 + ((i * 37) % 53)));
      const microBatches = planEmbeddingMicroBatches(texts, 3);
      expect(microBatches).toHaveLength(12);
      const totals = microBatches.map((m) => charTotal(texts, m));
      const mean = totals.reduce((sum, t) => sum + t, 0) / totals.length;
      for (const total of totals) expect(Math.abs(total - mean)).toBeLessThanOrEqual(53);
    });

    it("covers every index exactly once, contiguously", () => {
      const texts = Array.from({ length: 97 }, (_, i) => "z".repeat(1 + ((i * 37) % 53)));
      expectContiguousCover(planEmbeddingMicroBatches(texts, 5), texts.length);
    });

    it("handles empty strings without losing indices", () => {
      const texts = ["", "", "abc", ""];
      expectContiguousCover(planEmbeddingMicroBatches(texts, 4), texts.length);
    });
  });

  describe("degenerate inputs", () => {
    it("plans nothing for empty input", () => {
      expect(planEmbeddingMicroBatches([], 4)).toEqual([]);
    });

    it("plans one micro-batch for a single text", () => {
      expect(planEmbeddingMicroBatches(["t0"], 4)).toEqual([[0]]);
    });
  });
});
