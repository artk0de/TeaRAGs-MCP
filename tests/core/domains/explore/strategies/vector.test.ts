import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../../../src/core/contracts/types/trajectory.js";
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

const RELATIVE_PATH: PayloadSignalDescriptor = {
  key: "relativePath",
  type: "string",
  description: "path",
  level: "file",
};
const GIT_FILE_COMMITS: PayloadSignalDescriptor = {
  key: "git.file.commitCount",
  type: "number",
  description: "commits",
};

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

  it("honours a requested limit below 5 (tea-rags-mcp-9mwny)", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      id: String(i),
      score: 1 - i * 0.01,
      payload: { relativePath: `src/f${i}.ts` },
    }));
    const results = await createStrategy(createMockQdrant(many)).execute({
      collectionName: "test_col",
      embedding: [0.1],
      limit: 2,
    });
    expect(results).toHaveLength(2);
  });

  it("throws if embedding is missing", async () => {
    const strategy = createStrategy();
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires an embedding");
  });

  // bd tea-rags-mcp-947xf / mwq0k: a file hit names the file. The members
  // outline is gone (find_symbol(relativePath) owns the file outline), so one
  // hit per group is all the server needs to return, and the representative
  // chunk's own fields no longer leak onto the file row.
  it("returns a file hit with no members outline and no chunk-scoped fields", async () => {
    const qdrant = {
      queryGroups: vi.fn().mockResolvedValue([
        {
          id: "1",
          score: 0.9,
          payload: {
            relativePath: "src/a.ts",
            name: "Alpha",
            symbolId: "Alpha",
            startLine: 1,
            content: "class Alpha {}",
            git: { file: { commitCount: 4 }, chunk: { commitCount: 1 } },
          },
        },
      ]),
    } as unknown as QdrantManager;
    const strategy = new VectorSearchStrategy(qdrant, mockReranker, [GIT_FILE_COMMITS], []);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1, 0.2, 0.3],
      limit: 10,
      level: "file",
    });

    const groupSize = (qdrant.queryGroups as ReturnType<typeof vi.fn>).mock.calls[0][2].groupSize as number;
    expect(groupSize).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0.9);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts", git: { file: { commitCount: 4 } } });
  });

  // The strip is response shaping: the reranker must still see the full
  // representative chunk payload (chunk signals, language, chunkType feed
  // alpha-blending and overlay labels), and its order must survive the strip.
  it("reranks the full chunk payload at file level, then strips, keeping rank order and the overlay", async () => {
    const qdrant = {
      queryGroups: vi.fn().mockResolvedValue([
        {
          id: "a",
          score: 0.9,
          payload: { relativePath: "src/a.ts", startLine: 1, git: { chunk: { commitCount: 1 } } },
        },
        {
          id: "b",
          score: 0.8,
          payload: { relativePath: "src/b.ts", startLine: 9, git: { chunk: { commitCount: 7 } } },
        },
      ]),
    } as unknown as QdrantManager;
    const seen: Record<string, unknown>[] = [];
    const reranker = {
      rerank: vi.fn((results: { payload?: Record<string, unknown>; score: number }[]) => {
        for (const r of results) seen.push(structuredClone(r.payload ?? {}));
        return [...results]
          .reverse()
          .map((r, i) => ({ ...r, score: 1 - i * 0.1, rankingOverlay: { preset: "hotspots", file: { x: i } } }));
      }),
    } as unknown as Reranker;
    const strategy = new VectorSearchStrategy(qdrant, reranker, [GIT_FILE_COMMITS], []);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1],
      limit: 10,
      level: "file",
      rerank: "hotspots",
    });

    expect(seen).toEqual([
      { relativePath: "src/a.ts", startLine: 1, git: { chunk: { commitCount: 1 } } },
      { relativePath: "src/b.ts", startLine: 9, git: { chunk: { commitCount: 7 } } },
    ]);
    expect(results.map((r) => r.id)).toEqual(["b", "a"]);
    expect(results.map((r) => r.score)).toEqual([1, 0.9]);
    expect(results[0].rankingOverlay).toEqual({ preset: "hotspots", file: { x: 0 } });
    expect(results[0].payload).toEqual({ relativePath: "src/b.ts" });
  });

  // bd tea-rags-mcp-947xf: metaOnly copied the top-level score into the
  // payload, so every hit carried it twice — at chunk level as well.
  it.each(["chunk", "file"] as const)("carries no payload.score under metaOnly at level %s", async (level) => {
    const hit = { id: "1", score: 0.9, payload: { relativePath: "src/a.ts" } };
    const qdrant = {
      search: vi.fn().mockResolvedValue([hit]),
      queryGroups: vi.fn().mockResolvedValue([hit]),
    } as unknown as QdrantManager;
    const strategy = new VectorSearchStrategy(qdrant, mockReranker, [RELATIVE_PATH], []);

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1],
      limit: 10,
      level,
      metaOnly: true,
    });

    expect(results[0].score).toBe(0.9);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts" });
  });

  // metaOnly contract (2026-09-24): the payload stays RAW — labels live only on
  // rankingOverlay, which a metaOnly hit keeps.
  it("keeps rankingOverlay under metaOnly and leaves the payload raw", async () => {
    const overlay = { preset: "hotspots", file: { commitCount: { value: 37, label: "extreme" } } };
    const hit = { id: "1", score: 0.9, payload: { relativePath: "src/a.ts", git: { file: { commitCount: 37 } } } };
    const qdrant = { search: vi.fn().mockResolvedValue([hit]) } as unknown as QdrantManager;
    const reranker = {
      rerank: vi.fn((results: object[]) => results.map((r) => ({ ...r, rankingOverlay: overlay }))),
    } as unknown as Reranker;
    const strategy = new VectorSearchStrategy(
      qdrant,
      reranker,
      [RELATIVE_PATH, GIT_FILE_COMMITS],
      ["git.file.commitCount"],
    );

    const results = await strategy.execute({
      collectionName: "test_col",
      embedding: [0.1],
      limit: 10,
      rerank: "hotspots",
      metaOnly: true,
    });

    expect(results[0].rankingOverlay).toEqual(overlay);
    expect(results[0].payload).toEqual({ relativePath: "src/a.ts", git: { file: { commitCount: 37 } } });
  });
});
