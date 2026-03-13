import { describe, expect, it, vi } from "vitest";

import type { DerivedSignalDescriptor } from "../../../../src/core/contracts/types/reranker.js";
import { RankModule } from "../../../../src/core/domains/explore/rank-module.js";
import type { Reranker } from "../../../../src/core/domains/explore/reranker.js";

// Minimal descriptors for testing
const chunkSizeDesc: DerivedSignalDescriptor = {
  name: "chunkSize",
  description: "size",
  sources: ["methodLines"],
  defaultBound: 500,
  extract: (raw) => {
    const v = (raw.methodLines as number) || 0;
    return Math.min(1, v / 500);
  },
};

const churnDesc: DerivedSignalDescriptor = {
  name: "churn",
  description: "churn",
  sources: ["file.commitCount", "chunk.commitCount"],
  defaultBound: 50,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return Math.min(1, (git?.file?.commitCount ?? 0) / 50);
  },
};

const recencyDesc: DerivedSignalDescriptor = {
  name: "recency",
  description: "recency",
  sources: ["file.ageDays", "chunk.ageDays"],
  defaultBound: 365,
  inverted: true,
  extract: (raw) => {
    const git = raw.git as Record<string, Record<string, number>> | undefined;
    return 1 - Math.min(1, (git?.file?.ageDays ?? 0) / 365);
  },
};

function createMockScrollFn(data: Map<string, { id: string | number; payload: Record<string, unknown> }[]>) {
  return vi.fn().mockImplementation(async (_col: string, orderBy: { key: string }) => {
    return Promise.resolve(data.get(orderBy.key) ?? []);
  });
}

function createMockReranker(): Reranker {
  return {
    rerank: vi.fn().mockImplementation((results: { score: number }[]) => {
      return results.map((r) => ({ ...r, rankingOverlay: { preset: "test" } }));
    }),
    getPreset: vi.fn(),
    getAvailablePresets: vi.fn().mockReturnValue(["decomposition"]),
  } as unknown as Reranker;
}

describe("RankModule", () => {
  describe("resolveOrderByFields", () => {
    it("resolves chunk-level fields from sources and inverted flag", () => {
      const module = new RankModule(createMockReranker(), [chunkSizeDesc, churnDesc, recencyDesc]);

      const fields = module.resolveOrderByFields({ chunkSize: 0.5, churn: 0.3, recency: 0.2 }, "chunk");

      expect(fields).toEqual([
        { key: "methodLines", direction: "desc" },
        { key: "git.chunk.commitCount", direction: "desc" },
        { key: "git.chunk.ageDays", direction: "asc" },
      ]);
    });

    it("resolves file-level fields when level=file", () => {
      const module = new RankModule(createMockReranker(), [churnDesc]);

      const fields = module.resolveOrderByFields({ churn: 1.0 }, "file");

      expect(fields).toEqual([{ key: "git.file.commitCount", direction: "desc" }]);
    });

    it("skips similarity weight", () => {
      const module = new RankModule(createMockReranker(), [chunkSizeDesc]);

      const fields = module.resolveOrderByFields({ similarity: 0.5, chunkSize: 0.5 }, "chunk");

      expect(fields).toHaveLength(1);
      expect(fields[0].key).toBe("methodLines");
    });

    it("returns empty for unknown descriptors", () => {
      const module = new RankModule(createMockReranker(), []);

      const fields = module.resolveOrderByFields({ unknown: 1.0 }, "chunk");

      expect(fields).toEqual([]);
    });
  });

  describe("rankChunks", () => {
    it("performs scatter-gather and returns merged results", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200, relativePath: "big.ts" } },
            { id: "b", payload: { methodLines: 100, relativePath: "medium.ts" } },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc]);

      const results = await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(mockScroll).toHaveBeenCalledTimes(1);
      expect(mockReranker.rerank).toHaveBeenCalledTimes(1);
      expect(results).toHaveLength(2);
    });

    it("deduplicates points from multiple scrolls", async () => {
      const scrollData = new Map([
        [
          "methodLines",
          [
            { id: "a", payload: { methodLines: 200 } },
            { id: "b", payload: { methodLines: 100 } },
          ],
        ],
        [
          "git.chunk.commitCount",
          [
            { id: "b", payload: { methodLines: 100 } },
            { id: "c", payload: { methodLines: 50 } },
          ],
        ],
      ]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc, churnDesc]);

      await module.rankChunks("test-col", {
        weights: { chunkSize: 0.5, churn: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      const rerankedInput = (mockReranker.rerank as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(rerankedInput).toHaveLength(3); // a, b, c — b deduplicated
    });

    it("removes similarity from weights and re-normalizes", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);

      const mockScroll = createMockScrollFn(scrollData);
      const mockReranker = createMockReranker();
      const module = new RankModule(mockReranker, [chunkSizeDesc]);

      await module.rankChunks("test-col", {
        weights: { similarity: 0.5, chunkSize: 0.5 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      const rerankerCall = (mockReranker.rerank as ReturnType<typeof vi.fn>).mock.calls[0];
      const mode = rerankerCall[1];
      expect(mode.custom.similarity).toBeUndefined();
      expect(mode.custom.chunkSize).toBeCloseTo(1.0);
    });

    it("returns empty when all weights are similarity", async () => {
      const mockScroll = vi.fn();
      const module = new RankModule(createMockReranker(), [chunkSizeDesc]);

      const results = await module.rankChunks("test-col", {
        weights: { similarity: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      expect(results).toEqual([]);
      expect(mockScroll).not.toHaveBeenCalled();
    });

    it("uses overfetch factor of 3x", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);
      const mockScroll = createMockScrollFn(scrollData);
      const module = new RankModule(createMockReranker(), [chunkSizeDesc]);

      await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
      });

      // Should request 30 (10 * 3)
      expect(mockScroll).toHaveBeenCalledWith("test-col", expect.anything(), 30, undefined);
    });

    it("passes filter to scroll function", async () => {
      const scrollData = new Map([["methodLines", [{ id: "a", payload: { methodLines: 200 } }]]]);
      const mockScroll = createMockScrollFn(scrollData);
      const module = new RankModule(createMockReranker(), [chunkSizeDesc]);
      const filter = { must: [{ key: "language", match: { value: "typescript" } }] };

      await module.rankChunks("test-col", {
        weights: { chunkSize: 1.0 },
        level: "chunk",
        limit: 10,
        scrollFn: mockScroll,
        filter,
      });

      expect(mockScroll).toHaveBeenCalledWith("test-col", expect.anything(), 30, filter);
    });
  });
});
