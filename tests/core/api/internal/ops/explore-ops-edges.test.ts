/**
 * ExploreOps — edge-case behavioral tests targeting branches not exercised
 * by the higher-level explore-facade tests.
 *
 * Three branches are notoriously underexercised because the happy path on
 * the facade always wires a statsCache, a path-bearing request, and an
 * explicit rerank:
 *
 *   1. `getIndexMetrics` without statsCache → must throw NotIndexedError.
 *      The IndexMetricsQuery is only constructed when deps.statsCache is
 *      set, so a collection without it can never produce metrics.
 *
 *   2. `checkDrift` collection-only branch — when a request only has a
 *      `collection` (no path) the drift monitor must be queried by
 *      collection name, CONSUMING: a collection-addressed request is still
 *      a search. The path branch is exercised by every existing test; the
 *      collection-name branch is the symmetric case.
 *
 *   3. `resolveDocRerank` documentation-auto-preset — when no explicit
 *      rerank is given but the caller signals a docs query
 *      (`documentation: "only"` or `language: "markdown"`), the ops
 *      auto-applies `documentationRelevance` so callers don't have to
 *      memorize the preset name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

// ---------------------------------------------------------------------------
// Shared mocks — keep light, no global tree-sitter mock needed here.
// ---------------------------------------------------------------------------

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

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi
      .fn()
      .mockResolvedValue([{ id: "1", score: 0.9, payload: { relativePath: "src/a.md", content: "# heading" } }]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 0 }),
    getPoint: vi.fn().mockResolvedValue(null),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;
}

function makeMockReranker(overrides: Record<string, any> = {}) {
  return {
    hasCollectionStats: false,
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
    ...overrides,
  } as any;
}

function makeMockRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
  } as any;
}

function makeMockDriftReporter(overrides: Record<string, any> = {}) {
  return {
    checkAndConsume: vi.fn().mockResolvedValue(null),
    checkAndConsumeByCollectionName: vi.fn().mockReturnValue(null),
    checkByCollectionName: vi.fn().mockReturnValue(null),
    reset: vi.fn(),
    ...overrides,
  } as any;
}

/** One drifted payload key, and the text `formatIndexDriftReport` renders it as. */
const driftReport = {
  findings: [
    { axis: "payloadKeys", subject: "navigation", indexed: "absent", current: "declared", remedy: { kind: "force" } },
  ],
  remedy: { kind: "force" },
};
const driftReportText = "Payload keys:\n  navigation: absent → declared\nRun: tea-rags index-codebase --force";

// ---------------------------------------------------------------------------
// 1. getIndexMetrics without statsCache → NotIndexedError
// ---------------------------------------------------------------------------

describe("ExploreOps.getIndexMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NotIndexedError when no statsCache is provided (no IndexMetricsQuery to run)", async () => {
    // When deps.statsCache is undefined, ExploreOps does NOT construct the
    // IndexMetricsQuery instance. getIndexMetrics MUST throw NotIndexedError
    // rather than silently returning empty results.
    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: makeMockRegistry(),
      // statsCache intentionally omitted
      driftReporter: makeMockDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await expect(facade.getIndexMetrics("/tmp/no-stats-project")).rejects.toThrow(/not indexed/);
  });
});

// ---------------------------------------------------------------------------
// 2. checkDrift collection-only branch
// ---------------------------------------------------------------------------

describe("ExploreOps drift warning — collection-only path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the CONSUMING collection-name check when the request has a collection but no path", async () => {
    // When the caller passes `collection` directly (not `path`), the drift
    // monitor's collection-name branch must run — the path branch can't
    // because there is no path to check against the schema-version registry.
    // It consumes: a collection-addressed search is a search, and a warning it
    // renders is one the reader has now been shown.
    const driftReporter = makeMockDriftReporter({
      checkAndConsumeByCollectionName: vi.fn().mockReturnValue(driftReport),
    });
    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker: makeMockReranker(),
      registry: makeMockRegistry(),
      driftReporter,
      payloadSignals: [],
      essentialKeys: [],
    });

    const result = await facade.semanticSearch({
      collection: "code_explicit_no_path",
      query: "anything",
    });

    expect(driftReporter.checkAndConsume).not.toHaveBeenCalled();
    expect(driftReporter.checkByCollectionName).not.toHaveBeenCalled();
    expect(driftReporter.checkAndConsumeByCollectionName).toHaveBeenCalledWith("code_explicit_no_path");
    expect(result.driftWarning).toBe(driftReportText);
  });
});

// ---------------------------------------------------------------------------
// 3. resolveDocRerank auto-applies documentationRelevance preset
// ---------------------------------------------------------------------------

describe("ExploreOps documentation auto-rerank", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("auto-applies documentationRelevance preset when documentation='only' and no rerank given", async () => {
    // The semanticSearch path runs resolveDocRerank before resolveEffectiveLevel.
    // When the caller asks for docs-only without naming a preset, ops must
    // upgrade rerank to "documentationRelevance" so the preset's signalLevel
    // gets read by resolveEffectiveLevel — proving the auto-rerank ran.
    const getFullPreset = vi.fn().mockReturnValue({ signalLevel: undefined });
    const reranker = makeMockReranker({ getFullPreset });

    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker,
      registry: makeMockRegistry(),
      driftReporter: makeMockDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await facade.semanticSearch({
      collection: "test_col",
      query: "intro",
      documentation: "only",
    });

    // resolveEffectiveLevel got called with the auto-applied preset name.
    expect(getFullPreset).toHaveBeenCalledWith("documentationRelevance", "semantic_search");
  });

  it("auto-applies documentationRelevance preset when language='markdown' and no rerank given", async () => {
    const getFullPreset = vi.fn().mockReturnValue({ signalLevel: undefined });
    const reranker = makeMockReranker({ getFullPreset });

    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker,
      registry: makeMockRegistry(),
      driftReporter: makeMockDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await facade.semanticSearch({
      collection: "test_col",
      query: "tutorial",
      language: "markdown",
    });

    expect(getFullPreset).toHaveBeenCalledWith("documentationRelevance", "semantic_search");
  });

  it("does NOT auto-apply documentationRelevance when an explicit rerank is provided", async () => {
    // If the caller already named a preset, that wins — even if documentation=only.
    const getFullPreset = vi.fn().mockReturnValue({ signalLevel: undefined });
    const reranker = makeMockReranker({ getFullPreset });

    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker,
      registry: makeMockRegistry(),
      driftReporter: makeMockDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await facade.semanticSearch({
      collection: "test_col",
      query: "intro",
      documentation: "only",
      rerank: "techDebt",
    });

    expect(getFullPreset).toHaveBeenCalledWith("techDebt", "semantic_search");
    expect(getFullPreset).not.toHaveBeenCalledWith("documentationRelevance", "semantic_search");
  });
});

// ---------------------------------------------------------------------------
// 4. Collection stats are loaded BEFORE the filter is built
// ---------------------------------------------------------------------------

describe("ExploreOps stats-before-filter ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads collection stats before buildFilter so adaptive percentiles resolve on the first (cold) query", async () => {
    // Regression for the cold-query bug: ensureStats used to run only inside
    // executeExplore — AFTER buildFilter. That meant the first query to each
    // collection resolved {presets} adaptive percentiles with descriptor
    // FALLBACKS instead of the real Stats. The fix moves ensureStats ahead of
    // buildFilter in every filter-building path.
    //
    // We prove the ordering with a stateful reranker: getCollectionStats only
    // returns stats AFTER setCollectionStats was called (mirrors the real
    // reranker). buildFilter reads getCollectionStats via resolveFilterSpec, so
    // if it ran before ensureStats it would observe `undefined` (fallback path).
    // The registry's buildMergedFilter is the last thing buildFilter touches —
    // we capture whether stats were present at that moment.

    const fakeStats = { payloadFieldKeys: ["git.chunk.commitCount"] };
    let storedStats: unknown;

    const reranker = makeMockReranker({
      // Mirrors the real Reranker: once stats are set, hasCollectionStats
      // flips true so the guarded ensureStats inside executeExplore is a
      // cheap no-op (idempotent — load + setCollectionStats fire exactly once).
      setRecomputeService: vi.fn(),
      setCollectionStats: vi.fn((stats: unknown) => {
        storedStats = stats;
      }),
      getCollectionStats: vi.fn(() => storedStats),
    });
    Object.defineProperty(reranker, "hasCollectionStats", {
      get: () => storedStats !== undefined,
    });

    let statsPresentAtFilterBuild = false;
    const registry = makeMockRegistry();
    registry.buildMergedFilter = vi.fn().mockImplementation((_typed: any, rawFilter?: any) => {
      // At the instant the filter is assembled, the reranker MUST already
      // hold the collection stats — i.e. ensureStats ran first.
      statsPresentAtFilterBuild = reranker.getCollectionStats() !== undefined;
      return rawFilter;
    });

    const statsCache = {
      load: vi.fn().mockReturnValue(fakeStats),
    } as any;

    const facade = new ExploreFacade({
      qdrant: makeMockQdrant(),
      embeddings: makeMockEmbeddings(),
      reranker,
      registry,
      statsCache,
      driftReporter: makeMockDriftReporter(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await facade.semanticSearch({ collection: "code_cold", query: "anything" });

    expect(statsCache.load).toHaveBeenCalledWith("code_cold");
    expect(reranker.setCollectionStats).toHaveBeenCalledTimes(1);
    expect(registry.buildMergedFilter).toHaveBeenCalled();
    // The core assertion: stats were already loaded when the filter was built.
    expect(statsPresentAtFilterBuild).toBe(true);
  });
});
