import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import type { Reranker } from "../../../../src/core/explore/reranker.js";
import { createSearchStrategy } from "../../../../src/core/explore/strategies/factory.js";
import { HybridSearchStrategy } from "../../../../src/core/explore/strategies/hybrid.js";
import { ScrollRankStrategy } from "../../../../src/core/explore/strategies/scroll-rank.js";
import { VectorSearchStrategy } from "../../../../src/core/explore/strategies/vector.js";

const mockQdrant = {} as QdrantManager;
const mockReranker = {
  getDescriptors: vi.fn().mockReturnValue([]),
  rerank: vi.fn(),
} as unknown as Reranker;

describe("createSearchStrategy", () => {
  it("creates VectorSearchStrategy for 'vector'", () => {
    const strategy = createSearchStrategy("vector", mockQdrant, mockReranker);
    expect(strategy).toBeInstanceOf(VectorSearchStrategy);
    expect(strategy.type).toBe("vector");
  });

  it("creates HybridSearchStrategy for 'hybrid'", () => {
    const strategy = createSearchStrategy("hybrid", mockQdrant, mockReranker);
    expect(strategy).toBeInstanceOf(HybridSearchStrategy);
    expect(strategy.type).toBe("hybrid");
  });

  it("creates ScrollRankStrategy for 'scroll-rank'", () => {
    const strategy = createSearchStrategy("scroll-rank", mockQdrant, mockReranker);
    expect(strategy).toBeInstanceOf(ScrollRankStrategy);
    expect(strategy.type).toBe("scroll-rank");
  });

  it("throws for unknown strategy type", () => {
    expect(() => createSearchStrategy("unknown" as never, mockQdrant, mockReranker)).toThrow(
      "Unknown search strategy type",
    );
  });
});
