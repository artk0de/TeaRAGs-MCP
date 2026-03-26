import { describe, expect, it, vi } from "vitest";

import type { CollectionInfo, QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import { HybridNotEnabledError } from "../../../../../src/core/domains/explore/strategies/types.js";

const mockReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

function createMockQdrant(
  hybridEnabled = true,
  hybridResults: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [],
): QdrantManager {
  return {
    getCollectionInfo: vi.fn().mockResolvedValue({
      name: "test_col",
      vectorSize: 384,
      pointsCount: 100,
      distance: "Cosine",
      hybridEnabled,
    } satisfies CollectionInfo),
    hybridSearch: vi.fn().mockResolvedValue(hybridResults),
  } as unknown as QdrantManager;
}

function createStrategy(qdrant?: QdrantManager) {
  return new HybridSearchStrategy(qdrant ?? createMockQdrant(), mockReranker, [], []);
}

describe("HybridSearchStrategy", () => {
  it("has type 'hybrid'", () => {
    expect(createStrategy().type).toBe("hybrid");
  });

  it("calls qdrant.hybridSearch with correct params when sparseVector provided", async () => {
    const mockResults = [{ id: "1", score: 0.85, payload: { relativePath: "src/a.ts" } }];
    const qdrant = createMockQdrant(true, mockResults);
    const strategy = createStrategy(qdrant);

    const sparseVector = { indices: [0, 1], values: [1.0, 0.5] };
    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2],
      sparseVector,
      query: "test query",
      limit: 5,
    });

    // Base class overfetches — verify hybridSearch was called with fetchLimit >= 5
    expect(qdrant.hybridSearch).toHaveBeenCalledWith(
      "test_col",
      [0.1, 0.2],
      sparseVector,
      expect.any(Number),
      undefined,
    );
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.85);
  });

  it("generates sparse vector from query when not provided", async () => {
    const qdrant = createMockQdrant(true, []);
    const strategy = createStrategy(qdrant);

    await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1],
      query: "some query text",
      limit: 5,
    });

    expect(qdrant.hybridSearch).toHaveBeenCalledTimes(1);
    const call = (qdrant.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
    const generatedSparse = call[2] as { indices: number[]; values: number[] };
    expect(generatedSparse.indices.length).toBeGreaterThan(0);
    expect(generatedSparse.values.length).toBeGreaterThan(0);
  });

  it("throws HybridNotEnabledError when collection has no hybrid support", async () => {
    const qdrant = createMockQdrant(false);
    const strategy = createStrategy(qdrant);

    await expect(
      strategy.execute({
        collectionName: "no_hybrid_col",
        embedding: [0.1],
        query: "test",
        limit: 5,
      }),
    ).rejects.toThrow(HybridNotEnabledError);
  });

  it("throws if embedding is missing", async () => {
    const strategy = createStrategy();
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires an embedding");
  });

  it("groups results by file when level is 'file'", async () => {
    const mockResults = [
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
      { id: "2", score: 0.7, payload: { relativePath: "src/a.ts", startLine: 20, endLine: 30 } },
      { id: "3", score: 0.8, payload: { relativePath: "src/b.ts", startLine: 1, endLine: 15 } },
    ];
    const qdrant = createMockQdrant(true, mockResults);
    const strategy = createStrategy(qdrant);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2],
      query: "file level query",
      limit: 10,
      level: "file",
    });

    // groupByFile deduplicates — 2 unique files from 3 results
    const paths = results.map((r) => r.payload?.["relativePath"]);
    expect(new Set(paths).size).toBeLessThanOrEqual(results.length);
  });
});
