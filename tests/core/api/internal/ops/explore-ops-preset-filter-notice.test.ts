/**
 * ExploreOps — the preset-default filter notice (bd tea-rags-mcp-0qfpi).
 *
 * A rerank preset can carry a DEFAULT `filter`, and when the caller passed no
 * `filter` of their own that default silently narrows the candidate set. The
 * response now says so: which rerank preset, which filter-preset conditions,
 * and the literal param that clears it.
 *
 * The notice is for the DEFAULT case ONLY. A caller who wrote their own filter
 * knows what they wrote; a caller who cleared it with `filter: {}` knows too;
 * and a default that `presetDefaultExcludesCallerScope` already dropped never
 * reached the query, so there is nothing to report.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildPresetFilterNotice, ExploreOps } from "../../../../../src/core/api/internal/ops/explore-ops.js";
import type { FilterPresetDef } from "../../../../../src/core/contracts/types/filter-preset.js";

// ---------------------------------------------------------------------------
// Module mocks — mirror explore-ops-confidence.test.ts exactly.
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const productionDef: FilterPresetDef = {
  name: "production",
  description: "no tests",
  conditions: [{ signal: "isTest", op: "eq", value: true, occur: "must_not" }],
};

const coreLogicDef: FilterPresetDef = {
  name: "coreLogic",
  description: "functions and classes only",
  conditions: [{ signal: "chunkType", op: "eq", value: ["function", "class"], occur: "must" }],
};

const HITS = [{ id: "1", score: 0.7, payload: { relativePath: "src/core/domains/explore/reranker.ts" } }];

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeMockQdrant(overrides: Record<string, any> = {}) {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    scrollFiltered: vi.fn().mockResolvedValue(HITS),
    getPoint: vi.fn().mockResolvedValue(null),
    search: vi.fn().mockResolvedValue(HITS),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi.fn().mockResolvedValue(HITS),
    query: vi.fn().mockResolvedValue(HITS),
    scrollAll: vi.fn().mockResolvedValue([]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    ensurePayloadIndex: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

function makeMockEmbeddings() {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] }),
    embedBatch: vi.fn().mockResolvedValue([{ embedding: [0.1, 0.2, 0.3] }]),
    getDimensions: vi.fn().mockReturnValue(3),
  } as any;
}

function makeMockReranker(presetFilter?: unknown) {
  return {
    hasCollectionStats: false,
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined, filter: presetFilter }),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeMockRegistry(overrides: Record<string, any> = {}) {
  const defs = new Map([
    ["production", productionDef],
    ["coreLogic", coreLogicDef],
  ]);
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getFilterPresetDef: vi.fn().mockImplementation((name: string) => defs.get(name)),
    ...overrides,
  } as any;
}

function makeMockCollectionRegistry() {
  return {
    findByName: vi.fn().mockReturnValue(null),
    findByPath: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as any;
}

function makeOps(presetFilter?: unknown, registry = makeMockRegistry()) {
  return new ExploreOps({
    qdrant: makeMockQdrant(),
    embeddings: makeMockEmbeddings(),
    reranker: makeMockReranker(presetFilter),
    registry,
    collectionRegistry: makeMockCollectionRegistry(),
    payloadSignals: [],
    essentialKeys: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExploreOps — preset default filter notice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the rerank preset, the condition and the escape hatch when a default narrowed the set", async () => {
    const ops = makeOps({ presets: "production" });

    const response = await ops.hybridSearch({
      collection: "code_test_col",
      query: "env snapshot",
      rerank: "techDebt",
    });

    expect(response.presetFilterNotice).toEqual({
      preset: "techDebt",
      by: "production (isTest)",
      clearWith: "filter: {}",
    });
  });

  it("omits the notice when the caller wrote their own filter", async () => {
    const ops = makeOps({ presets: "production" });

    const response = await ops.hybridSearch({
      collection: "code_test_col",
      query: "env snapshot",
      rerank: "techDebt",
      filter: { must: [{ key: "language", match: { value: "typescript" } }] },
    });

    expect(response.presetFilterNotice).toBeUndefined();
  });

  it("omits the notice when the caller cleared the default with filter: {}", async () => {
    const ops = makeOps({ presets: "production" });

    const response = await ops.hybridSearch({
      collection: "code_test_col",
      query: "env snapshot",
      rerank: "techDebt",
      filter: {},
    });

    expect(response.presetFilterNotice).toBeUndefined();
  });

  it("omits the notice when the rerank preset declares no default filter", async () => {
    const ops = makeOps(undefined);

    const response = await ops.hybridSearch({
      collection: "code_test_col",
      query: "env snapshot",
      rerank: "relevance",
    });

    expect(response.presetFilterNotice).toBeUndefined();
  });

  it("omits the notice when the default was dropped for excluding the caller's own scope", async () => {
    // testFile: "only" compiles to a must isTest=true, which the production
    // default's must_not contradicts — ExploreOps drops the default outright,
    // so nothing narrowed and there is nothing to report.
    const registry = makeMockRegistry({
      buildFilter: vi.fn().mockReturnValue({ must: [{ key: "isTest", match: { value: true } }] }),
    });
    const ops = makeOps({ presets: "production" }, registry);

    const response = await ops.hybridSearch({
      collection: "code_test_col",
      query: "env snapshot",
      rerank: "techDebt",
      testFile: "only",
    });

    expect(response.presetFilterNotice).toBeUndefined();
  });

  it("rides the rank_chunks response too", async () => {
    const ops = makeOps({ presets: "coreLogic" });

    const response = await ops.rankChunks({
      collection: "code_test_col",
      rerank: "decomposition",
    });

    expect(response.presetFilterNotice).toEqual({
      preset: "decomposition",
      by: "coreLogic (chunkType)",
      clearWith: "filter: {}",
    });
  });

  it("rides the find_similar response too", async () => {
    const ops = makeOps({ presets: "production" });
    const response = await ops.findSimilar(
      { collection: "code_test_col", positiveCode: ["const a = 1;"], rerank: "hotspots" },
      ops.buildSimilarStrategy({ collection: "code_test_col", positiveCode: ["const a = 1;"] }),
    );

    expect(response.presetFilterNotice).toEqual({
      preset: "hotspots",
      by: "production (isTest)",
      clearWith: "filter: {}",
    });
  });
});

describe("buildPresetFilterNotice", () => {
  it("lists every payload key the compiled default constrains, de-duplicated and in order", () => {
    const notice = buildPresetFilterNotice(
      "techDebt",
      { presets: "production,coreLogic" },
      {
        must: [
          { key: "chunkType", match: { any: ["function", "class"] } },
          { key: "chunkType", match: { any: ["function", "class"] } },
        ],
        must_not: [{ key: "isTest", match: { value: true } }],
      },
    );

    expect(notice).toEqual({
      preset: "techDebt",
      by: "production+coreLogic (chunkType, isTest)",
      clearWith: "filter: {}",
    });
  });

  it("names a raw default filter as such — it carries no filter-preset name", () => {
    const notice = buildPresetFilterNotice(
      "custom",
      { must_not: [{ key: "isTest", match: { value: true } }] },
      {
        must_not: [{ key: "isTest", match: { value: true } }],
      },
    );

    expect(notice?.by).toBe("raw filter (isTest)");
  });

  it("reads keys out of a nested should group", () => {
    const notice = buildPresetFilterNotice(
      "techDebt",
      { presets: "production" },
      {
        must: [{ should: [{ key: "git.file.commitCount", range: { gte: 10 } }] }],
      },
    );

    expect(notice?.by).toBe("production (git.file.commitCount)");
  });

  it("returns undefined when the compiled default carries no condition at all", () => {
    expect(buildPresetFilterNotice("techDebt", { presets: "production" }, undefined)).toBeUndefined();
    expect(buildPresetFilterNotice("techDebt", { presets: "production" }, {})).toBeUndefined();
  });
});
