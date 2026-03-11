import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { VectorSearchStrategy } from "../../../../src/core/explore/strategies/vector.js";

function createMockQdrant(
  searchResults: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [],
): QdrantManager {
  return {
    search: vi.fn().mockResolvedValue(searchResults),
  } as unknown as QdrantManager;
}

describe("VectorSearchStrategy", () => {
  it("has type 'vector'", () => {
    const strategy = new VectorSearchStrategy(createMockQdrant());
    expect(strategy.type).toBe("vector");
  });

  it("calls qdrant.search with correct params", async () => {
    const mockResults = [
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } },
      { id: "2", score: 0.8, payload: { relativePath: "src/b.ts" } },
    ];
    const qdrant = createMockQdrant(mockResults);
    const strategy = new VectorSearchStrategy(qdrant);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2, 0.3],
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    expect(qdrant.search).toHaveBeenCalledWith("test_col", [0.1, 0.2, 0.3], 10, {
      must: [{ key: "language", match: { value: "typescript" } }],
    });
    expect(results).toHaveLength(2);
    expect(results[0].score).toBe(0.9);
  });

  it("throws if embedding is missing", async () => {
    const strategy = new VectorSearchStrategy(createMockQdrant());
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires an embedding");
  });
});
