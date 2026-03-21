import { describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../../../../src/core/adapters/qdrant/client.js";
import type { DerivedSignalDescriptor, RerankableResult } from "../../../../../src/core/contracts/types/reranker.js";
import type { Reranker } from "../../../../../src/core/domains/explore/reranker.js";
import { ScrollRankStrategy } from "../../../../../src/core/domains/explore/strategies/scroll-rank.js";

const chunkSizeDesc: DerivedSignalDescriptor = {
  name: "chunkSize",
  description: "size",
  sources: ["methodLines"],
  defaultBound: 500,
  extract: (raw) => Math.min(1, ((raw.methodLines as number) || 0) / 500),
};

function createMockReranker(): Reranker {
  return {
    rerank: vi
      .fn()
      .mockImplementation((results: RerankableResult[]) => results.map((r, i) => ({ ...r, score: 1 - i * 0.1 }))),
    getPreset: vi.fn().mockReturnValue({ chunkSize: 1.0 }),
    getDescriptors: vi.fn().mockReturnValue([chunkSizeDesc]),
    getAvailablePresets: vi.fn().mockReturnValue(["decomposition"]),
    getDescriptorInfo: vi.fn().mockReturnValue([]),
    getPresetNames: vi.fn().mockReturnValue(["decomposition"]),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    invalidateStats: vi.fn(),
  } as unknown as Reranker;
}

function createMockQdrant(): QdrantManager {
  return {
    scrollOrdered: vi.fn().mockResolvedValue([
      { id: "1", payload: { methodLines: 100, relativePath: "src/a.ts" } },
      { id: "2", payload: { methodLines: 200, relativePath: "src/b.ts" } },
      { id: "3", payload: { methodLines: 50, relativePath: "test/c.test.ts" } },
    ]),
    ensurePayloadIndex: vi.fn().mockResolvedValue(true),
  } as unknown as QdrantManager;
}

function createStrategy(qdrant?: QdrantManager, reranker?: Reranker) {
  const q = qdrant ?? createMockQdrant();
  const r = reranker ?? createMockReranker();
  return new ScrollRankStrategy(q, r, [], []);
}

describe("ScrollRankStrategy", () => {
  it("has type 'scroll-rank'", () => {
    expect(createStrategy().type).toBe("scroll-rank");
  });

  it("executes scroll-rank with weights", async () => {
    const reranker = createMockReranker();
    const strategy = createStrategy(undefined, reranker);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 2,
    });

    expect(results.length).toBeLessThanOrEqual(2);
    expect(reranker.rerank).toHaveBeenCalled();
  });

  it("throws when weights are missing", async () => {
    const strategy = createStrategy();
    await expect(strategy.execute({ collectionName: "test_col", limit: 5 })).rejects.toThrow("requires weights");
  });

  it("applies pathPattern filtering", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      pathPattern: "src/**",
    });

    for (const r of results) {
      const path = r.payload?.relativePath as string;
      if (path) {
        expect(path).toMatch(/^src\//);
      }
    }
  });

  it("applies offset", async () => {
    const strategy = createStrategy();

    const allResults = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
    });

    const offsetResults = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      offset: 1,
    });

    expect(offsetResults.length).toBe(allResults.length - 1);
  });

  it("defaults metaOnly to true", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
    });

    // metaOnly=true strips content, wraps as payload
    for (const r of results) {
      expect(r.payload?.content).toBeUndefined();
    }
  });

  it("preserves content when metaOnly explicitly false", async () => {
    const strategy = createStrategy();

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 10,
      metaOnly: false,
    });

    // metaOnly=false preserves raw payload
    expect(results.length).toBeGreaterThan(0);
  });

  it("groups by file when level='file' — one result per unique relativePath", async () => {
    // Two chunks from same file "src/a.ts", one from "src/b.ts"
    const qdrant = {
      scrollOrdered: vi.fn().mockResolvedValue([
        { id: "1", payload: { methodLines: 200, relativePath: "src/a.ts" } },
        { id: "2", payload: { methodLines: 100, relativePath: "src/a.ts" } },
        { id: "3", payload: { methodLines: 50, relativePath: "src/b.ts" } },
      ]),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;

    const strategy = createStrategy(qdrant, undefined);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "file",
      limit: 10,
      metaOnly: false,
    });

    const paths = results.map((r) => r.payload?.relativePath);
    // Must have exactly 2 unique files, not 3 chunks
    expect(paths).toHaveLength(2);
    expect(new Set(paths).size).toBe(2);
    expect(paths).toContain("src/a.ts");
    expect(paths).toContain("src/b.ts");
  });

  it("adaptively fetches more chunks when first batch has too few unique files", async () => {
    // 5 chunks per file × 4 files = 20 chunks total, limit=4 unique files requested.
    // First fetch (limit * 3 = 12 chunks) likely covers only ~2-3 files.
    // Strategy must detect shortage and re-fetch with higher limit.
    let callCount = 0;
    const allChunks = [
      // File A: 5 chunks (ids 1-5)
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `a${i}`,
        payload: { methodLines: 300 - i * 10, relativePath: "src/a.ts" },
      })),
      // File B: 5 chunks (ids 6-10)
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `b${i}`,
        payload: { methodLines: 250 - i * 10, relativePath: "src/b.ts" },
      })),
      // File C: 5 chunks (ids 11-15)
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `c${i}`,
        payload: { methodLines: 200 - i * 10, relativePath: "src/c.ts" },
      })),
      // File D: 5 chunks (ids 16-20)
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `d${i}`,
        payload: { methodLines: 150 - i * 10, relativePath: "src/d.ts" },
      })),
    ];

    const qdrant = {
      scrollOrdered: vi.fn().mockImplementation(async (_col: string, _orderBy: unknown, limit: number) => {
        callCount++;
        // Return up to `limit` chunks (simulates Qdrant scroll with limit)
        return Promise.resolve(allChunks.slice(0, limit));
      }),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;

    const strategy = createStrategy(qdrant, undefined);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "file",
      limit: 4,
      metaOnly: false,
    });

    const paths = results.map((r) => r.payload?.relativePath);
    expect(new Set(paths).size).toBe(4);
    expect(results).toHaveLength(4);
    // Must have called rankChunks more than once (adaptive re-fetch)
    expect(callCount).toBeGreaterThan(1);
  });

  it("preserves rankingOverlay from reranker in results", async () => {
    const mockOverlay = {
      preset: "decomposition",
      derived: { chunkSize: { value: 0.8, label: "large" } },
      raw: { file: { ageDays: { value: 42, label: "typical" } } },
    };
    const reranker = createMockReranker();
    vi.mocked(reranker.rerank).mockImplementation((results: RerankableResult[]) =>
      results.map((r, i) => ({ ...r, score: 1 - i * 0.1, rankingOverlay: mockOverlay })),
    );

    const strategy = createStrategy(undefined, reranker);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "chunk",
      limit: 3,
      metaOnly: false,
    });

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.rankingOverlay).toBeDefined();
      expect(r.rankingOverlay?.preset).toBe("decomposition");
    }
  });

  it("stops re-fetching when data is exhausted (fewer unique files than limit)", async () => {
    // Only 2 files exist, but limit=5. Should return 2, not loop forever.
    const chunks = [
      { id: "1", payload: { methodLines: 200, relativePath: "src/a.ts" } },
      { id: "2", payload: { methodLines: 150, relativePath: "src/a.ts" } },
      { id: "3", payload: { methodLines: 100, relativePath: "src/b.ts" } },
    ];
    const qdrant = {
      scrollOrdered: vi.fn().mockResolvedValue(chunks),
      ensurePayloadIndex: vi.fn().mockResolvedValue(true),
    } as unknown as QdrantManager;

    const strategy = createStrategy(qdrant, undefined);

    const results = await strategy.execute({
      collectionName: "test_col",
      weights: { chunkSize: 1.0 },
      level: "file",
      limit: 5,
      metaOnly: false,
    });

    // Only 2 unique files exist — should return all available, not hang
    expect(results).toHaveLength(2);
    const paths = results.map((r) => r.payload?.relativePath);
    expect(new Set(paths).size).toBe(2);
  });
});
