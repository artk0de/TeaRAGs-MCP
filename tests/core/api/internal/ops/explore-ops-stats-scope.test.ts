/**
 * ExploreOps — collection stats belong to A collection, and to a revision of it.
 *
 * The reranker resolves overlay labels and adaptive filter-preset thresholds
 * from whatever `CollectionSignalStats` it was last handed. `ensureStats` is the
 * only thing that hands them over, so its guard decides which project's
 * distribution every answer is measured against.
 *
 * Two failures live in that guard (bd tea-rags-mcp-yntsd):
 *   - asking "are ANY stats loaded" lets the first collection searched in a
 *     process label every later one, across projects;
 *   - nothing notices a stats file rewritten by another process, so a CLI
 *     reindex never reaches a running MCP server.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";

vi.mock("../../../../../src/core/domains/explore/post-process.js", () => ({
  computeFetchLimit: vi.fn((limit?: number) => ({
    requestedLimit: limit ?? 5,
    fetchLimit: (limit ?? 5) * 3,
  })),
  postProcess: vi.fn((results: any[]) => results),
  filterMetaOnly: vi.fn((results: any[]) =>
    results.map((r: any) => ({ score: r.score, relativePath: r.payload?.relativePath })),
  ),
}));

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1], values: [0.5] })),
  BM25SparseVectorGenerator: { generateSimple: vi.fn(() => ({ indices: [1], values: [0.5] })) },
}));

const HITS = [{ id: "1", score: 0.8, payload: { relativePath: "src/a.ts" } }];

/** Distinguishable distributions — whose numbers arrived is the assertion. */
function statsNamed(marker: string) {
  return {
    perSignal: new Map([[marker, { count: 1, min: 1, max: 1, percentiles: {} }]]),
    perLanguage: new Map(),
    distributions: {},
    computedAt: 1,
  } as any;
}

function makeMockQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue([]),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue(HITS),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    query: vi.fn().mockResolvedValue([]),
    scrollAll: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
  } as any;
}

/**
 * Mirrors the real Reranker's bookkeeping: it remembers WHICH collection and
 * WHICH revision the stats it holds came from, and answers accordingly.
 */
function makeStatsTrackingReranker() {
  let held: { collectionName?: string; revision?: number } = {};
  return {
    get hasCollectionStats() {
      return held.collectionName !== undefined;
    },
    hasCollectionStatsFor: vi.fn(
      (collectionName: string, revision?: number) =>
        held.collectionName === collectionName && held.revision === revision,
    ),
    setCollectionStats: vi.fn((_stats: any, opts?: any) => {
      held = { collectionName: opts?.collectionName, revision: opts?.revision };
    }),
    setRecomputeService: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

/** Stats files on disk, keyed by collection, each with a write revision. */
function makeStatsCache(files: Record<string, { revision: number; stats: any }>) {
  return {
    load: vi.fn((collectionName: string) => files[collectionName]?.stats ?? null),
    lastWrittenAt: vi.fn((collectionName: string) => files[collectionName]?.revision),
  } as any;
}

function makeOps(reranker: any, statsCache: any) {
  return new ExploreOps({
    qdrant: makeMockQdrant(),
    embeddings: { embed: vi.fn().mockResolvedValue({ embedding: [0.1] }), getDimensions: vi.fn().mockReturnValue(1) },
    reranker,
    registry: {
      buildFilter: vi.fn().mockReturnValue(undefined),
      buildMergedFilter: vi.fn().mockImplementation((_t: any, raw?: any) => raw),
      getAllFilters: vi.fn().mockReturnValue([]),
      getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
      getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
      getFilterPresetDef: vi.fn().mockReturnValue(undefined),
    },
    collectionRegistry: {
      findByName: vi.fn().mockReturnValue(null),
      findByPath: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
    },
    statsCache,
    payloadSignals: [],
    essentialKeys: [],
  } as any);
}

/** The collection name each setCollectionStats call was made for, in order. */
function loadedFor(reranker: any): (string | undefined)[] {
  return reranker.setCollectionStats.mock.calls.map((c: any[]) => c[1]?.collectionName);
}

describe("ExploreOps — collection stats are scoped to their collection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the second project's stats instead of labelling it with the first project's", async () => {
    const reranker = makeStatsTrackingReranker();
    const ops = makeOps(
      reranker,
      makeStatsCache({
        code_tearags: { revision: 100, stats: statsNamed("tea-rags-distribution") },
        code_taxdome: { revision: 200, stats: statsNamed("taxdome-distribution") },
      }),
    );

    await ops.semanticSearch({ query: "anything", collection: "code_tearags" });
    await ops.semanticSearch({ query: "anything", collection: "code_taxdome" });

    expect(loadedFor(reranker)).toEqual(["code_tearags", "code_taxdome"]);
    const taxdomeStats = reranker.setCollectionStats.mock.calls.at(-1)?.[0];
    expect(taxdomeStats.perSignal.has("taxdome-distribution")).toBe(true);
  });

  it("keeps caching a collection whose stats file has not moved", async () => {
    const reranker = makeStatsTrackingReranker();
    const ops = makeOps(reranker, makeStatsCache({ code_tearags: { revision: 100, stats: statsNamed("first") } }));

    await ops.semanticSearch({ query: "one", collection: "code_tearags" });
    await ops.semanticSearch({ query: "two", collection: "code_tearags" });
    await ops.semanticSearch({ query: "three", collection: "code_tearags" });

    expect(reranker.setCollectionStats).toHaveBeenCalledTimes(1);
  });

  it("picks up a stats file another process rewrote", async () => {
    const reranker = makeStatsTrackingReranker();
    const files = { code_tearags: { revision: 100, stats: statsNamed("before-recompute") } };
    const ops = makeOps(reranker, makeStatsCache(files));

    await ops.semanticSearch({ query: "before", collection: "code_tearags" });
    // A CLI reindex recomputes and rewrites the file out of process.
    files.code_tearags = { revision: 999, stats: statsNamed("after-recompute") };
    await ops.semanticSearch({ query: "after", collection: "code_tearags" });

    expect(reranker.setCollectionStats).toHaveBeenCalledTimes(2);
    const latest = reranker.setCollectionStats.mock.calls.at(-1)?.[0];
    expect(latest.perSignal.has("after-recompute")).toBe(true);
  });

  it("does not re-read on every query when the collection alternates back and forth", async () => {
    const reranker = makeStatsTrackingReranker();
    const statsCache = makeStatsCache({
      code_a: { revision: 1, stats: statsNamed("a") },
      code_b: { revision: 2, stats: statsNamed("b") },
    });
    const ops = makeOps(reranker, statsCache);

    await ops.semanticSearch({ query: "q", collection: "code_a" });
    await ops.semanticSearch({ query: "q", collection: "code_b" });
    await ops.semanticSearch({ query: "q", collection: "code_a" });

    // Alternating legitimately reloads — the reranker holds one collection's
    // stats at a time — but the cheap revision probe must be what decides,
    // never a blind reload of an unchanged collection.
    expect(loadedFor(reranker)).toEqual(["code_a", "code_b", "code_a"]);
    expect(statsCache.lastWrittenAt).toHaveBeenCalled();
  });
});
