import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { ExploreFacade } from "../../../src/core/api/internal/facades/explore-facade.js";
import type { TrajectoryRegistry } from "../../../src/core/contracts/types/trajectory.js";
import type { Reranker } from "../../../src/core/domains/explore/reranker.js";

function createMockDeps() {
  const qdrant = {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    scrollOrdered: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([{ id: "r1", score: 0.9, payload: { relativePath: "src/a.ts" } }]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false }),
  } as unknown as QdrantManager;

  const embeddings = {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3], dimensions: 3 }),
    embedBatch: vi.fn().mockResolvedValue([]),
    getDimensions: vi.fn().mockReturnValue(3),
    getModel: vi.fn().mockReturnValue("test"),
  } as unknown as EmbeddingProvider;

  const reranker = {
    rerank: vi.fn((r: unknown[]) => r),
    getPresetNames: vi.fn().mockReturnValue(["relevance"]),
    getPreset: vi.fn(),
    getDescriptors: vi.fn().mockReturnValue([]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
  } as unknown as Reranker;

  const registry = {
    buildMergedFilter: vi.fn().mockReturnValue(undefined),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getAllPresets: vi.fn().mockReturnValue([]),
    getAllDerivedSignals: vi.fn().mockReturnValue([]),
    getAllFilters: vi.fn().mockReturnValue([]),
  } as unknown as TrajectoryRegistry;

  return { qdrant, embeddings, reranker, registry };
}

describe("ExploreFacade.findSimilar()", () => {
  it("returns results from SimilarSearchStrategy", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    const response = await facade.findSimilar({
      collection: "test_col",
      positiveIds: ["uuid-1"],
    });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].id).toBe("r1");
    expect(response.results[0].score).toBe(0.9);
  });

  it("throws when no inputs provided at all", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    await expect(facade.findSimilar({ collection: "test_col" })).rejects.toThrow(
      "At least one positive or negative input is required",
    );
  });

  it("throws when average_vector used with zero positives", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    await expect(
      facade.findSimilar({
        collection: "test_col",
        negativeIds: ["neg-1"],
        strategy: "average_vector",
      }),
    ).rejects.toThrow("requires at least one positive");
  });

  it("allows best_score with negative-only (zero positives)", async () => {
    const deps = createMockDeps();
    const facade = new ExploreFacade(deps);

    const response = await facade.findSimilar({
      collection: "test_col",
      negativeIds: ["neg-1"],
      strategy: "best_score",
    });

    expect(response.results).toHaveLength(1);
  });

  it("passes embeddings to SimilarSearchStrategy for code embedding", async () => {
    const deps = createMockDeps();
    (deps.embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.5, 0.6, 0.7], dimensions: 3 },
    ]);
    const facade = new ExploreFacade(deps);

    await facade.findSimilar({
      collection: "test_col",
      positiveCode: ["function foo() {}"],
    });

    expect(deps.embeddings.embedBatch).toHaveBeenCalledWith(["function foo() {}"]);
  });
});
