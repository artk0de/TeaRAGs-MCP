/**
 * semantic_search / hybrid_search with several query variants (bd
 * tea-rags-mcp-2vuz): the strategy sends ONE fused Qdrant request — one leg
 * per variant — instead of its single-query request.
 */
import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { generateSparseVector } from "../../../../../src/core/adapters/qdrant/sparse.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { HybridSearchStrategy } from "../../../../../src/core/domains/explore/strategies/hybrid.js";
import { VectorSearchStrategy } from "../../../../../src/core/domains/explore/strategies/vector.js";

const mockReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

const FUSED = [
  { id: "both", score: 0.033, payload: { relativePath: "src/both.ts" } },
  { id: "only-a", score: 0.016, payload: { relativePath: "src/a.ts" } },
];

function createMockQdrant(): QdrantManager {
  return {
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 2 }),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    fusedSearch: vi.fn().mockResolvedValue(FUSED),
  } as unknown as QdrantManager;
}

const variants = [
  { query: "rate limit", embedding: [0.1, 0.2] },
  { query: "retry after", embedding: [0.3, 0.4] },
];

describe("query variants — VectorSearchStrategy", () => {
  it("fuses one dense leg per variant in a single request and keeps Qdrant's order", async () => {
    const qdrant = createMockQdrant();
    const strategy = new VectorSearchStrategy(qdrant, mockReranker, [], []);

    const results = await strategy.execute({
      collectionName: "col",
      embedding: [0.1, 0.2],
      queryVariants: variants,
      limit: 2,
    });

    expect(qdrant.fusedSearch).toHaveBeenCalledTimes(1);
    expect(qdrant.fusedSearch).toHaveBeenCalledWith(
      "col",
      [{ dense: [0.1, 0.2] }, { dense: [0.3, 0.4] }],
      expect.any(Number),
      undefined,
    );
    expect(qdrant.search).not.toHaveBeenCalled();
    expect(results.map((r) => r.id)).toEqual(["both", "only-a"]);
  });
});

describe("query variants — HybridSearchStrategy", () => {
  it("fuses a dense + sparse leg per variant in a single request", async () => {
    const qdrant = createMockQdrant();
    const strategy = new HybridSearchStrategy(qdrant, mockReranker, [], []);

    const results = await strategy.execute({
      collectionName: "col",
      embedding: [0.1, 0.2],
      query: "rate limit ||| retry after",
      queryVariants: variants,
      limit: 2,
    });

    expect(qdrant.fusedSearch).toHaveBeenCalledTimes(1);
    expect(qdrant.fusedSearch).toHaveBeenCalledWith(
      "col",
      [
        { dense: [0.1, 0.2], sparse: generateSparseVector("rate limit") },
        { dense: [0.3, 0.4], sparse: generateSparseVector("retry after") },
      ],
      expect.any(Number),
      undefined,
    );
    expect(qdrant.hybridSearch).not.toHaveBeenCalled();
    expect(results.map((r) => r.id)).toEqual(["both", "only-a"]);
  });

  it("fuses the sparse legs alone when the variants could not be embedded", async () => {
    const qdrant = createMockQdrant();
    const strategy = new HybridSearchStrategy(qdrant, mockReranker, [], []);

    await strategy.execute({
      collectionName: "col",
      queryVariants: [{ query: "rate limit" }, { query: "retry after" }],
      limit: 2,
      denseUnavailable: { reason: "provider down" },
    });

    expect(qdrant.fusedSearch).toHaveBeenCalledWith(
      "col",
      [{ sparse: generateSparseVector("rate limit") }, { sparse: generateSparseVector("retry after") }],
      expect.any(Number),
      undefined,
    );
  });
});
