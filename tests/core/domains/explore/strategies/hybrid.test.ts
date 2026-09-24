import { describe, expect, it, vi } from "vitest";

import type { CollectionInfo, QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import {
  QdrantInvalidQueryParameterError,
  QdrantOperationError,
} from "../../../../../src/core/adapters/qdrant/errors.js";
import { InvalidQueryError } from "../../../../../src/core/domains/explore/errors.js";
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

  it("honours a requested limit below 5 (tea-rags-mcp-9mwny)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      score: 1 - i * 0.01,
      payload: { relativePath: `src/f${i}.ts` },
    }));
    const results = await createStrategy(createMockQdrant(true, many)).execute({
      collectionName: "test_col",
      embedding: [0.1],
      query: "q",
      limit: 3,
    });
    expect(results).toHaveLength(3);
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

  // tea-rags-mcp-2fefq: for an identifier query both legs missed the symbol's
  // own chunks (dense ranked tiny look-alikes first, BM25 drowned the tokens in
  // their domain). The identity leg is the only carrier of "this chunk belongs
  // to symbol X": the dense vector restricted to exact symbolId/parentSymbolId.
  describe("identity leg (tea-rags-mcp-2fefq)", () => {
    const requestFilter = { must: [{ key: "isTest", match: { value: true } }] };
    const workerIdentity = {
      should: [
        {
          must: [
            { key: "parentSymbolId", match: { text: "Worker" } },
            { key: "parentSymbolId", match: { value: "Platform::Async::Operation::Worker" } },
          ],
        },
        {
          must: [
            { key: "symbolId", match: { text: "Worker" } },
            { key: "symbolId", match: { value: "Platform::Async::Operation::Worker" } },
          ],
        },
      ],
    };

    it("asks for an identity prefetch filter when the query is one identifier, keeping the request filter", async () => {
      const qdrant = createMockQdrant(true, []);
      const sparseVector = { indices: [3], values: [1] };

      await createStrategy(qdrant).execute({
        collectionName: "test_col",
        embedding: [0.1, 0.2],
        sparseVector,
        query: "Platform::Async::Operation::Worker",
        limit: 5,
        filter: requestFilter,
      });

      expect(qdrant.hybridSearch).toHaveBeenCalledWith(
        "test_col",
        [0.1, 0.2],
        sparseVector,
        expect.any(Number),
        requestFilter,
        undefined,
        workerIdentity,
      );
    });

    it("sends exactly today's five-argument request for a natural-language query", async () => {
      const qdrant = createMockQdrant(true, []);
      const sparseVector = { indices: [3], values: [1] };

      await createStrategy(qdrant).execute({
        collectionName: "test_col",
        embedding: [0.1, 0.2],
        sparseVector,
        query: "how does indexing work",
        limit: 5,
        filter: requestFilter,
      });

      const call = (qdrant.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call).toEqual(["test_col", [0.1, 0.2], sparseVector, expect.any(Number), requestFilter]);
      expect(call).toHaveLength(5);
    });

    it("keeps the file-level fetch limit and grouping when the identity leg is on", async () => {
      const mockResults = [
        { id: "1", score: 0.5, payload: { relativePath: "spec/worker_spec.rb", startLine: 1, endLine: 9 } },
        { id: "2", score: 0.4, payload: { relativePath: "spec/worker_spec.rb", startLine: 10, endLine: 20 } },
      ];
      const qdrant = createMockQdrant(true, mockResults);

      const results = await createStrategy(qdrant).execute({
        collectionName: "test_col",
        embedding: [0.1],
        query: "Platform::Async::Operation::Worker",
        limit: 4,
        level: "file",
      });

      const call = (qdrant.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
      const chunkCall = await (async () => {
        const chunkQdrant = createMockQdrant(true, []);
        await createStrategy(chunkQdrant).execute({
          collectionName: "test_col",
          embedding: [0.1],
          query: "Platform::Async::Operation::Worker",
          limit: 4,
        });
        return (chunkQdrant.hybridSearch as ReturnType<typeof vi.fn>).mock.calls[0];
      })();
      expect(call[3]).toBe((chunkCall[3] as number) * 3);
      expect(call[6]).toEqual(workerIdentity);
      expect(results).toHaveLength(1);
    });
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

    // FileLevelGrouper deduplicates — 2 unique files from 3 results
    const paths = results.map((r) => r.payload?.["relativePath"]);
    expect(new Set(paths).size).toBeLessThanOrEqual(results.length);
  });

  // bd tea-rags-mcp-947xf / mwq0k: the candidate pool covered nearly the whole
  // file, so `members` degenerated into the full outline find_symbol already
  // owns; and the representative chunk leaked its own line range and symbol.
  it("returns a file hit with no members outline and no chunk-scoped fields", async () => {
    const mockResults = [
      {
        id: "1",
        score: 0.9,
        payload: { relativePath: "src/a.ts", name: "Alpha", symbolId: "Alpha", startLine: 1, endLine: 10 },
      },
      {
        id: "2",
        score: 0.7,
        payload: {
          relativePath: "src/a.ts",
          name: "run",
          symbolId: "Alpha#run",
          parentSymbolId: "Alpha",
          startLine: 20,
          endLine: 30,
        },
      },
    ];
    const strategy = createStrategy(createMockQdrant(true, mockResults));

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2],
      query: "file level query",
      limit: 10,
      level: "file",
    });

    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts" });
  });

  // metaOnly contract (2026-09-24): labels live only on rankingOverlay.
  it("keeps rankingOverlay under metaOnly and leaves the payload raw", async () => {
    const overlay = { preset: "hotspots", file: { commitCount: { value: 37, label: "extreme" } } };
    const qdrant = createMockQdrant(true, [
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", git: { file: { commitCount: 37 } } } },
    ]);
    const reranker = {
      rerank: vi.fn((results: object[]) => results.map((r) => ({ ...r, rankingOverlay: overlay }))),
    } as unknown as Reranker;
    const strategy = new HybridSearchStrategy(
      qdrant,
      reranker,
      [
        { key: "relativePath", type: "string", description: "path" },
        { key: "git.file.commitCount", type: "number", description: "commits" },
      ],
      ["git.file.commitCount"],
    );

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2],
      query: "q",
      limit: 10,
      rerank: "hotspots",
      metaOnly: true,
    });

    expect(results[0].rankingOverlay).toEqual(overlay);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts", git: { file: { commitCount: 37 } } });
  });
});

describe("HybridSearchStrategy — adapter query-parameter rejection (bd tea-rags-mcp-pn12w)", () => {
  const reason = "semanticWeight must be a finite number in [0, 1]";

  function rejectingQdrant(error: Error): QdrantManager {
    const qdrant = createMockQdrant(true);
    vi.mocked(qdrant.hybridSearch).mockRejectedValue(error);
    return qdrant;
  }

  it("surfaces the adapter's rejection as the explore InvalidQueryError, byte-identical to the MCP client", async () => {
    const strategy = createStrategy(rejectingQdrant(new QdrantInvalidQueryParameterError(reason)));

    const error: unknown = await strategy
      .execute({ collectionName: "test_col", embedding: [0.1], query: "q", limit: 5 })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(InvalidQueryError);
    const mapped = error as InvalidQueryError;
    expect(mapped.code).toBe("EXPLORE_INVALID_QUERY");
    expect(mapped.httpStatus).toBe(400);
    expect(mapped.toUserMessage()).toBe(
      "[EXPLORE_INVALID_QUERY] Invalid query: semanticWeight must be a finite number in [0, 1]" +
        "\n\nHint: Provide a non-empty search query",
    );
  });

  it("lets every other adapter error through untouched", async () => {
    const unrelated = new QdrantOperationError("query", "boom");
    const strategy = createStrategy(rejectingQdrant(unrelated));

    await expect(strategy.execute({ collectionName: "test_col", embedding: [0.1], query: "q", limit: 5 })).rejects.toBe(
      unrelated,
    );
  });
});
