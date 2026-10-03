/**
 * ExploreOps — every query-time embed of a collection goes through THAT
 * collection's embedding binding (bd tea-rags-mcp-b91f5).
 *
 * The process embedding provider describes the server's spawn env, which is
 * only a default. A collection's binding comes from its registry entry, and
 * both its provider (the query vector) and its guard (the marker check) must be
 * the ones used — otherwise a project indexed with another model fails the
 * guard, or worse, is searched with a vector from the wrong space.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionEmbeddingsResolver } from "../../../../../src/core/api/internal/collection-embeddings.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";
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

const HITS = [{ id: "1", score: 0.7, payload: { relativePath: "src/a.ts" } }];

function makeQdrant() {
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
  } as any;
}

function makeEmbeddings(vector: number[]) {
  return {
    embed: vi.fn().mockResolvedValue({ embedding: vector }),
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: vector }))),
    getDimensions: vi.fn().mockReturnValue(vector.length),
    getModel: vi.fn().mockReturnValue("model"),
  } as any;
}

function makeGuard() {
  return { ensureMatch: vi.fn().mockResolvedValue(undefined) } as any;
}

function makeReranker() {
  return {
    hasCollectionStats: false,
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue(undefined),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
    getAllPayloadSignalDescriptors: vi.fn().mockReturnValue([]),
    getEssentialPayloadKeys: vi.fn().mockReturnValue([]),
    getFilterPresetDef: vi.fn().mockReturnValue(undefined),
  } as any;
}

function makeCollectionRegistry() {
  return {
    findByName: vi.fn().mockReturnValue(null),
    findByPath: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as any;
}

const COLLECTION = "code_pix";
const COLLECTION_VECTOR = [0.7, 0.7, 0.1];

function setup() {
  const qdrant = makeQdrant();
  const ambient = { embeddings: makeEmbeddings([1, 0, 0]), modelGuard: makeGuard() };
  const bound = { embeddings: makeEmbeddings(COLLECTION_VECTOR), modelGuard: makeGuard() };
  const resolver: CollectionEmbeddingsResolver = { forCollection: vi.fn(async () => bound) };
  const deps = {
    qdrant,
    embeddings: ambient.embeddings,
    modelGuard: ambient.modelGuard,
    collectionEmbeddings: resolver,
    reranker: makeReranker(),
    registry: makeRegistry(),
    collectionRegistry: makeCollectionRegistry(),
    payloadSignals: [],
    essentialKeys: [],
  };
  return { qdrant, ambient, bound, resolver, ops: new ExploreOps(deps), facade: new ExploreFacade(deps) };
}

/** The dense vector a qdrant search call was handed, whatever the strategy's call shape. */
function vectorsSentTo(qdrant: any): unknown[] {
  return [...qdrant.search.mock.calls, ...qdrant.hybridSearch.mock.calls, ...qdrant.query.mock.calls].flatMap(
    (call: unknown[]) => call,
  );
}

describe("ExploreOps — collection embedding binding (b91f5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hybrid_search embeds the query with the collection's provider and guards with its guard", async () => {
    const { ops, ambient, bound, resolver, qdrant } = setup();

    await ops.hybridSearch({ collection: COLLECTION, query: "endpoint pool" });

    expect(resolver.forCollection).toHaveBeenCalledWith(COLLECTION, { embeds: true });
    expect(bound.embeddings.embed).toHaveBeenCalledWith("endpoint pool");
    expect(bound.modelGuard.ensureMatch).toHaveBeenCalledWith(COLLECTION, { failOnProviderOutage: true });
    expect(ambient.embeddings.embed).not.toHaveBeenCalled();
    expect(ambient.modelGuard.ensureMatch).not.toHaveBeenCalled();
    expect(JSON.stringify(vectorsSentTo(qdrant))).toContain(JSON.stringify(COLLECTION_VECTOR));
  });

  it("semantic_search embeds the query with the collection's provider", async () => {
    const { ops, ambient, bound } = setup();

    await ops.semanticSearch({ collection: COLLECTION, query: "endpoint pool" });

    expect(bound.embeddings.embed).toHaveBeenCalledWith("endpoint pool");
    expect(ambient.embeddings.embed).not.toHaveBeenCalled();
  });

  it("search_code embeds the query with the collection's provider", async () => {
    const { ops, ambient, bound } = setup();

    await ops.searchCode({ collection: COLLECTION, query: "endpoint pool" });

    expect(bound.embeddings.embed).toHaveBeenCalledWith("endpoint pool");
    expect(bound.modelGuard.ensureMatch).toHaveBeenCalled();
    expect(ambient.embeddings.embed).not.toHaveBeenCalled();
  });

  it("find_similar embeds its code examples with the collection's provider", async () => {
    const { facade, ambient, bound } = setup();

    await facade.findSimilar({ collection: COLLECTION, positiveCode: ["const pool = new EndpointPool();"] });

    expect(bound.embeddings.embedBatch).toHaveBeenCalledWith(["const pool = new EndpointPool();"]);
    expect(ambient.embeddings.embedBatch).not.toHaveBeenCalled();
  });

  it("rank_chunks checks the model name with the collection's guard and embeds nothing", async () => {
    const { ops, ambient, bound, resolver } = setup();

    await ops.rankChunks({ collection: COLLECTION, rerank: "relevance" });

    expect(resolver.forCollection).toHaveBeenCalledWith(COLLECTION, { embeds: false });
    expect(bound.modelGuard.ensureMatch).toHaveBeenCalledWith(COLLECTION, { nameOnly: true });
    expect(ambient.modelGuard.ensureMatch).not.toHaveBeenCalled();
    expect(bound.embeddings.embed).not.toHaveBeenCalled();
  });

  it("without a resolver keeps the process provider and guard", async () => {
    const { qdrant, ambient } = setup();
    const ops = new ExploreOps({
      qdrant,
      embeddings: ambient.embeddings,
      modelGuard: ambient.modelGuard,
      reranker: makeReranker(),
      registry: makeRegistry(),
      collectionRegistry: makeCollectionRegistry(),
      payloadSignals: [],
      essentialKeys: [],
    });

    await ops.hybridSearch({ collection: COLLECTION, query: "endpoint pool" });

    expect(ambient.embeddings.embed).toHaveBeenCalledWith("endpoint pool");
    expect(ambient.modelGuard.ensureMatch).toHaveBeenCalled();
  });
});
