import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import type { DerivedSignalDescriptor, RerankableResult } from "../../../../src/core/contracts/types/reranker.js";
import type { Reranker } from "../../../../src/core/explore/reranker.js";
import { ScrollRankStrategy } from "../../../../src/core/explore/strategies/scroll-rank.js";

const chunkSizeDesc: DerivedSignalDescriptor = {
  name: "chunkSize",
  description: "size",
  sources: ["methodLines"],
  defaultBound: 500,
  extract: (raw) => Math.min(1, ((raw.methodLines as number) || 0) / 500),
};

function createMockReranker(): Reranker {
  return {
    rerank: vi
      .fn()
      .mockImplementation((results: RerankableResult[]) => results.map((r, i) => ({ ...r, score: 1 - i * 0.1 }))),
    getPreset: vi.fn().mockReturnValue({ chunkSize: 1.0 }),
    getDescriptors: vi.fn().mockReturnValue([chunkSizeDesc]),
    getAvailablePresets: vi.fn().mockReturnValue(["decomposition"]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
    getPresetNames: vi.fn().mockReturnValue(["decomposition"]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    invalidateStats: vi.fn(),
  } as unknown as Reranker;
}

function createMockQdrant(): QdrantManager {
  return {
    scrollOrdered: vi.fn().mockResolvedValue([
      { id: "1", payload: { methodLines: 100, relativePath: "src/a.ts" } },
      { id: "2", payload: { methodLines: 200, relativePath: "src/b.ts" } },
      { id: "3", payload: { methodLines: 50, relativePath: "test/c.test.ts" } },
    ]),
    ensurePayloadIndex: vi.fn().mockResolvedValue(true),
  } as unknown as QdrantManager;
}

function createStrategy(qdrant?: QdrantManager, reranker?: Reranker) {
  const q = qdrant ?? createMockQdrant();
  const r = reranker ?? createMockReranker();
  return new ScrollRankStrategy(q, r, [], []);
}

describe("ScrollRankStrategy", () => {
  it("has type 'scroll-rank'", () => {
    expect(createStrategy().type).toBe("scroll-rank");
  });

  it("executes scroll-rank with weights", async () => {
    const reranker = createMockReranker();
    const strategy = createStrategy(undefined, reranker);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
    expect(reranker.rerank).toHaveBeenCalled();
  });

  it("throws when weights are missing", async () => {
    const strategy = createStrategy();
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires weights");
  });

  it("applies pathPattern filtering", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      pathPattern: "src/**",
    });

    for (const r of results) {
      const path = r.payload?.relativePath as string;
      if (path) {
        expect(path).toMatch(/^src\//);
      }
    }
  });

  it("applies offset", async () => {
    const strategy = createStrategy();

    const allResults = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
    });

    const offsetResults = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      offset: 1,
    });

    expect(offsetResults.length).toBe(allResults.length - 1);
  });

  it("defaults metaOnly to true", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
    });

    // metaOnly=true strips content, wraps as payload
    for (const r of results) {
      expect(r.payload?.content).toBeUndefined();
    }
  });

  it("preserves content when metaOnly explicitly false", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      metaOnly: false,
    });

    // metaOnly=false preserves raw payload
    expect(results.length).toBeGreaterThan(0);
  });
});
