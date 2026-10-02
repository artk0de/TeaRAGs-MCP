import { describe, expect, it, vi } from "vitest";

import { codeRow, fakeWorkingTreeView } from "../__fixtures__/working-tree-view.js";
import type { EmbeddingProvider } from "../../../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import { QdrantPointNotFoundError } from "../../../../../src/core/adapters/qdrant/errors.js";
import { toQdrantPointId } from "../../../../../src/core/adapters/qdrant/point-id.js";
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

  it("honours a requested limit below 5 (tea-rags-mcp-9mwny)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      score: 1 - i * 0.01,
      payload: { relativePath: `src/f${i}.ts` },
    }));
    const results = await createStrategy({ qdrant: createMockQdrant(many) }).execute({
      collectionName: "col",
      limit: 1,
    });
    expect(results).toHaveLength(1);
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

  it("re-throws non-QdrantPointNotFoundError errors from qdrant.query unchanged", async () => {
    // The strategy wraps QdrantPointNotFoundError → ChunkNotFoundError, but any
    // other failure must propagate verbatim (e.g. connection errors). This
    // covers the `throw error;` rethrow branch.
    const qdrant = createMockQdrant();
    const rawError = new Error("unrelated qdrant failure");
    (qdrant.query as ReturnType<typeof vi.fn>).mockRejectedValue(rawError);
    const strategy = createStrategy({ qdrant, positiveIds: ["uuid-1"] });

    await expect(strategy.execute({ collectionName: "col", limit: 10 })).rejects.toBe(rawError);
  });

  it("groups results by relativePath when ctx.level is 'file' (client-side file-scope dedup)", async () => {
    // At file level, the strategy overfetches and then collapses chunks by
    // relativePath, keeping at most one chunk per file. Multiple chunks
    // pointing to the same file should yield exactly one result.
    const qdrant = createMockQdrant([
      { id: "1", score: 0.95, payload: { relativePath: "src/a.ts" } },
      { id: "2", score: 0.9, payload: { relativePath: "src/a.ts" } }, // same file
      { id: "3", score: 0.85, payload: { relativePath: "src/b.ts" } },
    ]);
    const strategy = createStrategy({ qdrant });

    const results = await strategy.execute({ collectionName: "col", limit: 5, level: "file" });

    // Exactly 2 unique files; same file collapsed to 1 entry.
    expect(results).toHaveLength(2);
    const paths = results.map((r) => r.payload?.relativePath).filter(Boolean);
    expect(new Set(paths)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
    // File level requests an overfetch limit (combination of BaseExploreStrategy's
    // overfetch factor and similar.ts's own 3× for file-level dedup).
    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(callArgs.limit).toBeGreaterThan(5); // strictly greater than user-requested limit
  });

  // bd tea-rags-mcp-947xf / mwq0k: a file hit names the file — no members
  // outline, no fields of whichever chunk happened to represent it.
  it("returns a file hit with no members outline and no chunk-scoped fields", async () => {
    const qdrant = createMockQdrant([
      { id: "1", score: 0.95, payload: { relativePath: "src/a.ts", name: "Alpha", symbolId: "Alpha", startLine: 1 } },
      {
        id: "2",
        score: 0.9,
        payload: {
          relativePath: "src/a.ts",
          name: "run",
          symbolId: "Alpha#run",
          parentSymbolId: "Alpha",
          startLine: 5,
        },
      },
    ]);
    const strategy = createStrategy({ qdrant });

    const results = await strategy.execute({ collectionName: "col", limit: 5, level: "file" });

    expect(results).toHaveLength(1);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts" });
  });

  it("returns userFilter unchanged when buildFilter produces no must clauses (empty must, has should)", async () => {
    // Edge case: userFilter only has `should`/`must_not` (no must, no extensions).
    // mustClauses stays empty after the merge loop → buildFilter returns the
    // original userFilter as-is so should/must_not are preserved.
    const qdrant = createMockQdrant();
    const strategy = createStrategy({ qdrant });
    const userFilter = {
      should: [{ key: "language", match: { value: "ruby" } }],
    };

    await strategy.execute({
      collectionName: "col",
      limit: 10,
      filter: userFilter,
    });

    const callArgs = (qdrant.query as ReturnType<typeof vi.fn>).mock.calls[0][1];
    // Original filter passed through, not wrapped/rebuilt.
    expect(callArgs.filter).toBe(userFilter);
  });

  // metaOnly contract (2026-09-24): labels live only on rankingOverlay.
  it("keeps rankingOverlay under metaOnly and leaves the payload raw", async () => {
    const overlay = { preset: "hotspots", file: { commitCount: { value: 37, label: "extreme" } } };
    const qdrant = createMockQdrant([
      { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", git: { file: { commitCount: 37 } } } },
    ]);
    const reranker = {
      rerank: vi.fn((results: object[]) => results.map((r) => ({ ...r, rankingOverlay: overlay }))),
    } as unknown as Reranker;
    const strategy = new SimilarSearchStrategy(
      qdrant,
      reranker,
      [
        { key: "relativePath", type: "string", description: "path" },
        { key: "git.file.commitCount", type: "number", description: "commits" },
      ],
      ["git.file.commitCount"],
      createMockEmbeddings(),
      { positiveIds: ["uuid-1"] },
    );

    const results = await strategy.execute({ collectionName: "col", limit: 5, rerank: "hotspots", metaOnly: true });

    expect(results[0].rankingOverlay).toEqual(overlay);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts", git: { file: { commitCount: 37 } } });
  });
});

/**
 * find_similar on a working tree (bd tea-rags-mcp-xi2r9, live probe P1-2):
 * hybrid_search and find_symbol hand out ids of the tree's rows, and a caller
 * passes them back. Such a row is not in Qdrant (or is, with the vector of the
 * pre-edit content), so its CONTENT is embedded and used as the example — the
 * vector the row would have once indexed. Any other id goes to Qdrant as an id.
 */
describe("SimilarSearchStrategy on a working tree", () => {
  const TREE_ROW_ID = String(toQdrantPointId("chunk_e61bd876bd62659c"));
  const treeRow = codeRow(TREE_ROW_ID, { relativePath: "src/touched.ts", content: "export function fresh() {}" });
  const negativeRow = codeRow(String(toQdrantPointId("chunk_0123456789abcdef")), {
    relativePath: "src/touched.ts",
    content: "export function stale() {}",
  });
  const view = () => fakeWorkingTreeView({ changed: ["src/touched.ts"], rows: [treeRow, negativeRow] });

  const embeddingsReturning = (...vectors: number[][]) => {
    const embeddings = createMockEmbeddings();
    vi.mocked(embeddings.embedBatch).mockResolvedValue(vectors.map((embedding) => ({ embedding, dimensions: 3 })));
    return embeddings;
  };

  it("should embed a tree row's content in place of its id, and send other ids as ids", async () => {
    const embeddings = embeddingsReturning([0.4, 0.5, 0.6]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({ qdrant, embeddings, positiveIds: [TREE_ROW_ID, "uuid-base"] });

    await strategy.execute({ collectionName: "col", limit: 10, workingTreeView: view() });

    expect(embeddings.embedBatch).toHaveBeenCalledWith(["export function fresh() {}"]);
    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({ positive: ["uuid-base", [0.4, 0.5, 0.6]] }),
    );
  });

  it("should resolve a tree row by the chunk id it was addressed by before ids were stored ids", async () => {
    const embeddings = embeddingsReturning([0.4, 0.5, 0.6]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({ qdrant, embeddings, positiveIds: ["chunk_e61bd876bd62659c"] });

    await strategy.execute({ collectionName: "col", limit: 10, workingTreeView: view() });

    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({ positive: [[0.4, 0.5, 0.6]] }));
  });

  it("should resolve tree rows given as negative examples after the caller's code examples", async () => {
    const embeddings = embeddingsReturning([0.1, 0.1, 0.1], [0.2, 0.2, 0.2], [0.3, 0.3, 0.3]);
    const qdrant = createMockQdrant();
    const strategy = createStrategy({
      qdrant,
      embeddings,
      positiveIds: [TREE_ROW_ID],
      negativeIds: [String(negativeRow.id)],
      negativeCode: ["caller negative"],
    });

    await strategy.execute({ collectionName: "col", limit: 10, workingTreeView: view() });

    expect(embeddings.embedBatch).toHaveBeenCalledWith([
      "export function fresh() {}",
      "caller negative",
      "export function stale() {}",
    ]);
    expect(qdrant.query).toHaveBeenCalledWith(
      "col",
      expect.objectContaining({
        positive: [[0.1, 0.1, 0.1]],
        negative: [
          [0.2, 0.2, 0.2],
          [0.3, 0.3, 0.3],
        ],
      }),
    );
  });

  it("should not read the tree's rows when the tree touched nothing", async () => {
    const readDeltaChunks = vi.fn(async () => [treeRow]);
    const untouched = { ...fakeWorkingTreeView({}), readDeltaChunks };
    const qdrant = createMockQdrant();

    await createStrategy({ qdrant, positiveIds: [TREE_ROW_ID] }).execute({
      collectionName: "col",
      limit: 10,
      workingTreeView: untouched,
    });

    expect(readDeltaChunks).not.toHaveBeenCalled();
    expect(qdrant.query).toHaveBeenCalledWith("col", expect.objectContaining({ positive: [TREE_ROW_ID] }));
  });
});
