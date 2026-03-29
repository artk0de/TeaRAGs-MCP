import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { ChunkNotFoundError } from "../../../../../src/core/domains/explore/errors.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { SimilarSearchStrategy } from "../../../../../src/core/domains/explore/strategies/similar.js";

const mockReranker = { rerank: vi.fn((r: unknown[]) => r) } as unknown as Reranker;

function createMockQdrant(
  queryResults: { id: string | number; score: number; payload?: Record<string, unknown> }[] = [],
): QdrantManager {
  return {
    query: vi.fn().mockResolvedValue(queryResults),
  } as unknown as QdrantManager;
}

function createMockEmbeddings(): EmbeddingProvider {
  return {
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0.1, 0.2, 0.3], dimensions: 3 }]),
    embed: vi.fn(),
    getDimensions: vi.fn().mockReturnValue(3),
    getModel: vi.fn().mockReturnValue("test-model"),
  } as unknown as EmbeddingProvider;
}

function createStrategy(opts?: {
  qdrant?: QdrantManager;
  embeddings?: EmbeddingProvider;
  positiveIds?: string[];
  positiveCode?: string[];
  negativeIds?: string[];
  negativeCode?: string[];
  strategy?: "best_score" | "average_vector" | "sum_scores";
  fileExtensions?: string[];
}) {
  return new SimilarSearchStrategy(
    opts?.qdrant ?? createMockQdrant(),
    mockReranker,
    [],
    [],
    opts?.embeddings ?? createMockEmbeddings(),
    {
      positiveIds: opts?.positiveIds ?? ["uuid-1"],
      positiveCode: opts?.positiveCode,
      negativeIds: opts?.negativeIds,
      negativeCode: opts?.negativeCode,
      strategy: opts?.strategy,
      fileExtensions: opts?.fileExtensions,
    },
  );
}

describe("SimilarSearchStrategy", () => {
  it("has type 'similar'", () => {
    expect(createStrategy().type).toBe("similar");
  });

  it("passes positiveIds directly to qdrant.query", async () => {
    const qdrant = createMockQdrant([{ id: "r1", score: 0.9, payload: { relativePath: "a.ts" } }]);
    const strategy = createStrategy({ qdrant, positiveIds: ["uuid-1", "uuid-2"] });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        positive: expect.arrayContaining(["uuid-1", "uuid-2"]),
      }),
    );
  });

  it("embeds positiveCode and merges with positiveIds", async () => {
    const embeddings = createMockEmbeddings();
    (embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.5, 0.6, 0.7], dimensions: 3 },
    ]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      embeddings,
      positiveIds: ["uuid-1"],
      positiveCode: ["function foo() {}"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).toHaveBeenCalledWith(["function foo() {}"]);
    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        positive: ["uuid-1", [0.5, 0.6, 0.7]],
      }),
    );
  });

  it("embeds negativeCode and merges with negativeIds", async () => {
    const embeddings = createMockEmbeddings();
    (embeddings.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValue([
      { embedding: [0.9, 0.8, 0.7], dimensions: 3 },
    ]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      embeddings,
      negativeIds: ["neg-1"],
      negativeCode: ["bad pattern"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        negative: ["neg-1", [0.9, 0.8, 0.7]],
      }),
    );
  });

  it("skips empty code blocks", async () => {
    const embeddings = createMockEmbeddings();
    const strategy = createStrategy({
      embeddings,
      positiveCode: ["", "  ", "valid code"],
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).toHaveBeenCalledWith(["valid code"]);
  });

  it("passes strategy to qdrant.query", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({ qdrant, strategy: "average_vector" });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        strategy: "average_vector",
      }),
    );
  });

  it("converts fileExtensions to Qdrant filter with match.any", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts", ".js"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [{ key: "fileExtension", match: { any: [".ts", ".js"] } }],
    });
  });

  it("merges fileExtensions filter with user-provided filter", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [
        { key: "language", match: { value: "typescript" } },
        { key: "fileExtension", match: { any: [".ts"] } },
      ],
    });
  });

  it("converts simple key-value filter to must format with fileExtensions", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
      filter: { language: "typescript", chunkType: "function" },
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [
        { key: "language", match: { value: "typescript" } },
        { key: "chunkType", match: { value: "function" } },
        { key: "fileExtension", match: { any: [".ts"] } },
      ],
    });
  });

  it("preserves should/must_not from user filter", async () => {
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      fileExtensions: [".ts"],
    });

    await strategy.execute({
      collectionName: "col",
      limit: 10,
      filter: {
        must: [{ key: "language", match: { value: "typescript" } }],
        should: [{ key: "chunkType", match: { value: "class" } }],
        must_not: [{ key: "isDocumentation", match: { value: true } }],
      },
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.filter).toEqual({
      must: [
        { key: "language", match: { value: "typescript" } },
        { key: "fileExtension", match: { any: [".ts"] } },
      ],
      should: [{ key: "chunkType", match: { value: "class" } }],
      must_not: [{ key: "isDocumentation", match: { value: true } }],
    });
  });

  it("throws ChunkNotFoundError when positiveIds contains non-existent chunk ID", async () => {
    const qdrant = createMockQdrant();
    (qdrant.query as ReturnType<typeof vi.fn>).mockRejectedValue(
      new QdrantPointNotFoundError("non-existent-uuid", "col"),
    );
    const strategy = createStrategy({ qdrant, positiveIds: ["non-existent-uuid"] });

    await expect(strategy.execute({ collectionName: "col", limit: 10 })).rejects.toThrow(ChunkNotFoundError);
    await expect(strategy.execute({ collectionName: "col", limit: 10 })).rejects.toMatchObject({
      code: "EXPLORE_CHUNK_NOT_FOUND",
    });
  });

  it("does not embed when only IDs provided", async () => {
    const embeddings = createMockEmbeddings();
    const strategy = createStrategy({
      embeddings,
      positiveIds: ["uuid-1"],
      positiveCode: undefined,
      negativeCode: undefined,
    });

    await strategy.execute({ collectionName: "col", limit: 10 });

    expect(embeddings.embedBatch).not.toHaveBeenCalled();
  });
});
