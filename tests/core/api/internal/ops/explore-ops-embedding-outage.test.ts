/**
 * ExploreOps with the embedding provider down.
 *
 * A read must not sit out the provider's recovery wait (EMBEDDING_TUNE_UNAVAILABLE_RETRY_MAX_WAIT_MS,
 * sized for a long index run): every query embed and the model guard's canary
 * on the read path get the read-path budget. hybrid_search still has its BM25
 * leg, so it answers from that alone and says so (`denseUnavailable`); the
 * dense-only tools fail at once with the provider's typed outage error.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { READ_PATH_EMBEDDING_RECOVERY_WAIT_MS } from "../../../../../src/core/adapters/embeddings/base.js";
import {
  LlamaServerResponseError,
  LlamaServerUnavailableError,
} from "../../../../../src/core/adapters/embeddings/llama-server/errors.js";
import { ExploreFacade } from "../../../../../src/core/api/internal/facades/explore-facade.js";

vi.mock("../../../../../src/core/adapters/qdrant/sparse.js", () => ({
  generateSparseVector: vi.fn(() => ({ indices: [1], values: [0.5] })),
  BM25SparseVectorGenerator: { generateSimple: vi.fn(() => ({ indices: [1], values: [0.5] })) },
}));

const SPARSE = { indices: [1], values: [0.5] };
const READ_BUDGET = { maxRecoveryWaitMs: READ_PATH_EMBEDDING_RECOVERY_WAIT_MS };

function makeQdrant() {
  return {
    collectionExists: vi.fn().mockResolvedValue(true),
    search: vi.fn().mockResolvedValue([]),
    queryGroups: vi.fn().mockResolvedValue([]),
    hybridSearch: vi
      .fn()
      .mockResolvedValue([{ id: "1", score: 0.5, payload: { relativePath: "src/reranker.ts", content: "rerank" } }]),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: true, pointsCount: 1 }),
    getPoint: vi.fn().mockResolvedValue(null),
  } as any;
}

function makeReranker() {
  return {
    hasCollectionStatsFor: vi.fn().mockReturnValue(false),
    setCollectionStats: vi.fn(),
    getCollectionStats: vi.fn().mockReturnValue(undefined),
    getPreset: vi.fn().mockReturnValue({ similarity: 1 }),
    getFullPreset: vi.fn().mockReturnValue({ signalLevel: undefined }),
    getDescriptors: vi.fn().mockReturnValue([]),
    rerank: vi.fn((results: any[]) => results),
  } as any;
}

function makeRegistry() {
  return {
    buildFilter: vi.fn().mockReturnValue(undefined),
    buildMergedFilter: vi.fn().mockImplementation((_typed: any, rawFilter?: any) => rawFilter),
    getAllFilters: vi.fn().mockReturnValue([]),
  } as any;
}

const outage = () => new LlamaServerUnavailableError("http://127.0.0.1:9", "http://127.0.0.1:9");

function makeFacade(embed: ReturnType<typeof vi.fn>, modelGuard?: { ensureMatch: ReturnType<typeof vi.fn> }) {
  const qdrant = makeQdrant();
  const facade = new ExploreFacade({
    qdrant,
    embeddings: { embed, embedBatch: vi.fn(), getDimensions: vi.fn().mockReturnValue(3) } as any,
    reranker: makeReranker(),
    registry: makeRegistry(),
    collectionRegistry: undefined as any,
    payloadSignals: [],
    essentialKeys: [],
    modelGuard: modelGuard as any,
  });
  return { facade, qdrant };
}

const request = { collection: "code_x", query: "Reranker rerank adaptive bounds", limit: 3 };

describe("ExploreOps — embedding provider down", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("hybrid_search", () => {
    it("answers from the BM25 leg alone and says the dense leg was unavailable", async () => {
      const embed = vi.fn().mockRejectedValue(outage());
      const { facade, qdrant } = makeFacade(embed);

      const response = await facade.hybridSearch(request);

      expect(embed).toHaveBeenCalledWith(request.query, READ_BUDGET);
      expect(qdrant.hybridSearch).toHaveBeenCalledTimes(1);
      const [collection, dense, sparse] = qdrant.hybridSearch.mock.calls[0];
      expect([collection, dense, sparse]).toEqual(["code_x", undefined, SPARSE]);
      expect(response.results.map((r) => r.id)).toEqual(["1"]);
      expect(response.denseUnavailable).toEqual({ reason: outage().message });
    });

    it("falls back when the model guard's canary already found the provider down, checking the name only", async () => {
      const embed = vi.fn();
      const ensureMatch = vi
        .fn()
        .mockImplementation(async (_c: string, options?: { nameOnly?: boolean }) =>
          options?.nameOnly ? undefined : Promise.reject(outage()),
        );
      const { facade, qdrant } = makeFacade(embed, { ensureMatch });

      const response = await facade.hybridSearch(request);

      expect(ensureMatch.mock.calls.map(([, options]) => options)).toEqual([
        { failOnProviderOutage: true, ...READ_BUDGET },
        { nameOnly: true },
      ]);
      expect(embed).not.toHaveBeenCalled();
      expect(qdrant.hybridSearch.mock.calls[0][1]).toBeUndefined();
      expect(response.denseUnavailable?.reason).toBe(outage().message);
    });

    it("checks the model name when the query embed found the provider down", async () => {
      const ensureMatch = vi.fn().mockResolvedValue(undefined);
      const { facade } = makeFacade(vi.fn().mockRejectedValue(outage()), { ensureMatch });

      await facade.hybridSearch(request);

      expect(ensureMatch).toHaveBeenLastCalledWith("code_x", { nameOnly: true });
    });

    it("keeps the dense leg and no marker when the provider answers", async () => {
      const embed = vi.fn().mockResolvedValue({ embedding: [0.1, 0.2, 0.3] });
      const { facade, qdrant } = makeFacade(embed);

      const response = await facade.hybridSearch(request);

      expect(qdrant.hybridSearch.mock.calls[0][1]).toEqual([0.1, 0.2, 0.3]);
      expect(response.denseUnavailable).toBeUndefined();
    });

    it("propagates a provider error that is not an outage", async () => {
      const rejected = new LlamaServerResponseError("http://127.0.0.1:9", 401, "bad key");
      const { facade, qdrant } = makeFacade(vi.fn().mockRejectedValue(rejected));

      await expect(facade.hybridSearch(request)).rejects.toBe(rejected);
      expect(qdrant.hybridSearch).not.toHaveBeenCalled();
    });
  });

  describe("tools that need the dense leg", () => {
    it("semantic_search fails at once with the typed outage, the embed held to the read budget", async () => {
      const down = outage();
      const embed = vi.fn().mockRejectedValue(down);
      const ensureMatch = vi.fn().mockResolvedValue(undefined);
      const { facade, qdrant } = makeFacade(embed, { ensureMatch });

      await expect(facade.semanticSearch(request)).rejects.toBe(down);
      expect(embed).toHaveBeenCalledWith(request.query, READ_BUDGET);
      expect(ensureMatch).toHaveBeenCalledWith("code_x", { failOnProviderOutage: true, ...READ_BUDGET });
      expect(qdrant.search).not.toHaveBeenCalled();
    });

    it("search_code holds its query embed to the read budget", async () => {
      const down = outage();
      const embed = vi.fn().mockRejectedValue(down);
      const { facade } = makeFacade(embed);

      await expect(facade.searchCode({ collection: "code_x", query: "q" })).rejects.toBe(down);
      expect(embed).toHaveBeenCalledWith("q", READ_BUDGET);
    });

    it("find_similar holds the guard's canary and its code embed to the read budget", async () => {
      const down = outage();
      const embedBatch = vi.fn().mockRejectedValue(down);
      const ensureMatch = vi.fn().mockResolvedValue(undefined);
      const qdrant = makeQdrant();
      const facade = new ExploreFacade({
        qdrant,
        embeddings: { embed: vi.fn(), embedBatch, getDimensions: vi.fn().mockReturnValue(3) } as any,
        reranker: makeReranker(),
        registry: makeRegistry(),
        collectionRegistry: undefined as any,
        modelGuard: { ensureMatch } as any,
      });

      await expect(facade.findSimilar({ collection: "code_x", positiveCode: ["function f() {}"] })).rejects.toBe(down);
      expect(ensureMatch).toHaveBeenCalledWith("code_x", READ_BUDGET);
      expect(embedBatch).toHaveBeenCalledWith(["function f() {}"], READ_BUDGET);
    });
  });
});
