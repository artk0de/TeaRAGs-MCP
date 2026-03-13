import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";

const mockReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

function createMockQdrant(
  searchResults: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [],
): QdrantManager {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
  } as unknown as QdrantManager;
}

function createStrategy(qdrant?: QdrantManager) {
  return new VectorSearchStrategy(qdrant ?? createMockQdrant(), mockReranker, [], []);
}

describe("VectorSearchStrategy", () => {
  it("has type 'vector'", () => {
    expect(createStrategy().type).toBe("vector");
  });

  it("calls qdrant.search with correct params", async () => {
    const mockResults = [
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
      { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
    ];
    const qdrant = createMockQdrant(mockResults);
    const strategy = createStrategy(qdrant);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2, 0.3],
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    // Base class overfetches — verify qdrant.search was called with fetchLimit >= 10
    expect(qdrant.search).toHaveBeenCalledWith("test_col", [0.1, 0.2, 0.3], expect.any(Number), {
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    const fetchLimit = (qdrant.search as ReturnType<typeof vi.fn>).mock.calls[0][2] as number;
    expect(fetchLimit).toBeGreaterThanOrEqual(10);
    // postProcess trims back to requested limit
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.9);
  });

  it("throws if embedding is missing", async () => {
    const strategy = createStrategy();
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires an embedding");
  });
});
