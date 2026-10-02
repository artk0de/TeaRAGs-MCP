import { describe, expect, it } from "vitest";

import {
  splitEmbeddingBatchAcrossEndpoints,
  type EmbeddingFanoutEndpoint,
  type EmbeddingFanoutRequest,
} from "../../../../src/core/adapters/embeddings/batch-fanout.js";

function equalTexts(n: number, size = 10): string[] {
  return Array.from({ length: n }, () => "x".repeat(size));
}

function countByUrl(requests: EmbeddingFanoutRequest[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of requests) counts[r.url] = (counts[r.url] ?? 0) + r.indices.length;
  return counts;
}

function expectPartition(requests: EmbeddingFanoutRequest[], n: number): void {
  const all = requests.flatMap((r) => r.indices);
  expect([...all].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
  expect(new Set(all).size).toBe(n);
  for (const r of requests) {
    expect(r.indices.length).toBeGreaterThan(0);
    expect(r.indices).toEqual([...r.indices].sort((a, b) => a - b));
  }
}

describe("splitEmbeddingBatchAcrossEndpoints", () => {
  describe("rule 1: weights", () => {
    it("weighs by charsPerSecond", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 300, slots: 1 },
        { url: "b", charsPerSecond: 100, slots: 1 },
      ];
      expect(countByUrl(splitEmbeddingBatchAcrossEndpoints(equalTexts(40), endpoints))).toEqual({ a: 30, b: 10 });
    });

    it("gives an unmeasured endpoint the mean of the measured ones", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 300, slots: 1 },
        { url: "b", charsPerSecond: 100, slots: 1 },
        { url: "c", slots: 1 },
      ];
      expect(countByUrl(splitEmbeddingBatchAcrossEndpoints(equalTexts(60), endpoints))).toEqual({
        a: 30,
        b: 10,
        c: 20,
      });
    });

    it("splits evenly when no endpoint is measured", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", slots: 1 },
        { url: "b", slots: 1 },
      ];
      expect(countByUrl(splitEmbeddingBatchAcrossEndpoints(equalTexts(20), endpoints))).toEqual({ a: 10, b: 10 });
    });

    it("splits two endpoints at 220 and 48 chars/s about 82/18 over 100 equal texts", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "fast", charsPerSecond: 220, slots: 1 },
        { url: "slow", charsPerSecond: 48, slots: 1 },
      ];
      const counts = countByUrl(splitEmbeddingBatchAcrossEndpoints(equalTexts(100), endpoints));
      expect(Math.abs(counts.fast - 82)).toBeLessThanOrEqual(2);
      expect(counts.fast + counts.slow).toBe(100);
    });
  });

  describe("rule 2: contiguous assignment by char share", () => {
    it("assigns each endpoint a contiguous run in endpoint order", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 1, slots: 1 },
        { url: "b", charsPerSecond: 1, slots: 1 },
      ];
      expect(splitEmbeddingBatchAcrossEndpoints(equalTexts(6), endpoints)).toEqual([
        { url: "a", indices: [0, 1, 2] },
        { url: "b", indices: [3, 4, 5] },
      ]);
    });

    it("splits uneven text lengths by chars, not by count", () => {
      const texts = ["x".repeat(900), ...Array.from({ length: 9 }, () => "y".repeat(100))];
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 1, slots: 1 },
        { url: "b", charsPerSecond: 1, slots: 1 },
      ];
      expect(splitEmbeddingBatchAcrossEndpoints(texts, endpoints)).toEqual([
        { url: "a", indices: [0] },
        { url: "b", indices: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
      ]);
    });

    it("gives every positive-weight endpoint at least one text while texts remain", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 10_000, slots: 1 },
        { url: "b", charsPerSecond: 1, slots: 1 },
        { url: "c", charsPerSecond: 1, slots: 1 },
      ];
      expect(countByUrl(splitEmbeddingBatchAcrossEndpoints(equalTexts(5), endpoints))).toEqual({ a: 3, b: 1, c: 1 });
    });

    it("leaves later endpoints out when there are fewer texts than endpoints", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", slots: 1 },
        { url: "b", slots: 1 },
        { url: "c", slots: 1 },
      ];
      expect(splitEmbeddingBatchAcrossEndpoints(equalTexts(2), endpoints)).toEqual([
        { url: "a", indices: [0] },
        { url: "b", indices: [1] },
      ]);
    });

    it("gives a zero-throughput endpoint nothing", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 100, slots: 1 },
        { url: "b", charsPerSecond: 0, slots: 1 },
      ];
      expect(splitEmbeddingBatchAcrossEndpoints(equalTexts(4), endpoints)).toEqual([
        { url: "a", indices: [0, 1, 2, 3] },
      ]);
    });
  });

  describe("rule 3: slots", () => {
    it("cuts 32 equal texts on 4 slots into 4 requests of 8", () => {
      const requests = splitEmbeddingBatchAcrossEndpoints(equalTexts(32), [{ url: "a", slots: 4 }]);
      expect(requests).toHaveLength(4);
      expect(requests.map((r) => r.indices.length)).toEqual([8, 8, 8, 8]);
      expect(requests.every((r) => r.url === "a")).toBe(true);
    });

    it("uses min(slots, run length) sub-requests", () => {
      const requests = splitEmbeddingBatchAcrossEndpoints(equalTexts(3), [{ url: "a", slots: 8 }]);
      expect(requests).toEqual([
        { url: "a", indices: [0] },
        { url: "a", indices: [1] },
        { url: "a", indices: [2] },
      ]);
    });

    it("cuts slot sub-requests by chars, not count", () => {
      const texts = ["x".repeat(300), "y".repeat(100), "y".repeat(100), "y".repeat(100)];
      expect(splitEmbeddingBatchAcrossEndpoints(texts, [{ url: "a", slots: 2 }])).toEqual([
        { url: "a", indices: [0] },
        { url: "a", indices: [1, 2, 3] },
      ]);
    });

    it("splits across endpoints first, then across each endpoint's slots", () => {
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "gpu0", charsPerSecond: 1, slots: 4 },
        { url: "gpu1", charsPerSecond: 1, slots: 4 },
      ];
      const requests = splitEmbeddingBatchAcrossEndpoints(equalTexts(256), endpoints);
      expect(requests).toHaveLength(8);
      expect(requests.map((r) => r.indices.length)).toEqual([32, 32, 32, 32, 32, 32, 32, 32]);
      expect(requests.slice(0, 4).every((r) => r.url === "gpu0")).toBe(true);
      expect(requests.slice(4).every((r) => r.url === "gpu1")).toBe(true);
    });
  });

  describe("rule 4: partition invariants", () => {
    it("covers 0..n-1 exactly once with ascending indices per request", () => {
      const texts = Array.from({ length: 97 }, (_, i) => "z".repeat(1 + ((i * 37) % 53)));
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", charsPerSecond: 220, slots: 3 },
        { url: "b", charsPerSecond: 48, slots: 2 },
        { url: "c", slots: 5 },
      ];
      expectPartition(splitEmbeddingBatchAcrossEndpoints(texts, endpoints), texts.length);
    });

    it("handles empty strings without losing indices", () => {
      const texts = ["", "", "abc", ""];
      const endpoints: EmbeddingFanoutEndpoint[] = [
        { url: "a", slots: 2 },
        { url: "b", slots: 2 },
      ];
      expectPartition(splitEmbeddingBatchAcrossEndpoints(texts, endpoints), texts.length);
    });
  });

  describe("rule 5: degenerate inputs", () => {
    it("returns no requests for empty texts", () => {
      expect(splitEmbeddingBatchAcrossEndpoints([], [{ url: "a", slots: 4 }])).toEqual([]);
    });

    it("sends everything in one request for one endpoint with one slot", () => {
      expect(splitEmbeddingBatchAcrossEndpoints(equalTexts(5), [{ url: "a", charsPerSecond: 50, slots: 1 }])).toEqual([
        { url: "a", indices: [0, 1, 2, 3, 4] },
      ]);
    });

    it("throws when texts are given but no endpoint is", () => {
      expect(() => splitEmbeddingBatchAcrossEndpoints(equalTexts(2), [])).toThrow(/no endpoint/i);
    });
  });
});
