import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import type { DerivedSignalDescriptor, RerankableResult } from "../../../../src/core/contracts/types/reranker.js";
import type { Reranker } from "../../../../src/core/explore/reranker.js";
import { excludeDocumentation, ScrollRankStrategy } from "../../../../src/core/explore/strategies/scroll-rank.js";

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

describe("ScrollRankStrategy", () => {
  it("has type 'scroll-rank'", () => {
    const strategy = new ScrollRankStrategy(createMockQdrant(), createMockReranker());
    expect(strategy.type).toBe("scroll-rank");
  });

  it("executes scroll-rank with weights", async () => {
    const qdrant = createMockQdrant();
    const reranker = createMockReranker();
    const strategy = new ScrollRankStrategy(qdrant, reranker);

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
    const strategy = new ScrollRankStrategy(createMockQdrant(), createMockReranker());
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires weights");
  });

  it("applies pathPattern filtering", async () => {
    const qdrant = createMockQdrant();
    const reranker = createMockReranker();
    const strategy = new ScrollRankStrategy(qdrant, reranker);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      pathPattern: "src/**",
    });

    // test/c.test.ts should be filtered out
    for (const r of results) {
      const path = r.payload?.relativePath as string;
      if (path) {
        expect(path).toMatch(/^src\//);
      }
    }
  });

  it("applies offset", async () => {
    const qdrant = createMockQdrant();
    const reranker = createMockReranker();
    const strategy = new ScrollRankStrategy(qdrant, reranker);

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

    // Offset should skip first result
    expect(offsetResults.length).toBe(allResults.length - 1);
  });
});

describe("excludeDocumentation", () => {
  it("creates must_not filter when no existing filter", () => {
    const result = excludeDocumentation();
    expect(result).toEqual({
      must_not: [{ key: "isDocumentation", match: { value: true } }],
    });
  });

  it("appends to existing must_not array", () => {
    const existing = {
      must: [{ key: "language", match: { value: "typescript" } }],
      must_not: [{ key: "chunkType", match: { value: "import" } }],
    };
    const result = excludeDocumentation(existing);
    expect(result.must_not).toHaveLength(2);
    expect(result.must).toEqual(existing.must);
  });

  it("creates must_not array when filter exists without must_not", () => {
    const existing = { must: [{ key: "language", match: { value: "typescript" } }] };
    const result = excludeDocumentation(existing);
    expect(result.must_not).toHaveLength(1);
    expect(result.must).toEqual(existing.must);
  });
});
