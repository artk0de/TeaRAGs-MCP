import { beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaUnavailableError } from "../../../src/core/adapters/embeddings/ollama/errors.js";
import { IngestFacade } from "../../../src/core/api/internal/facades/ingest-facade.js";

const { mockIndexCodebase, mockReindexChanges, mockScrollAllPoints, mockComputeStats } = vi.hoisted(() => ({
  mockIndexCodebase: vi.fn().mockResolvedValue({ chunksIndexed: 10 }),
  mockReindexChanges: vi.fn().mockResolvedValue({ added: 1, removed: 0 }),
  mockScrollAllPoints: vi.fn().mockResolvedValue([]),
  mockComputeStats: vi.fn().mockReturnValue({ computedAt: Date.now(), perSignal: new Map() }),
}));

vi.mock("../../../src/core/domains/ingest/indexing.js", () => ({
  IndexPipeline: class {
    indexCodebase = mockIndexCodebase;
  },
}));

vi.mock("../../../src/core/domains/ingest/reindexing.js", () => ({
  ReindexPipeline: class {
    reindexChanges = mockReindexChanges;
  },
}));

vi.mock("../../../src/core/domains/ingest/pipeline/status-module.js", () => ({
  StatusModule: class {
    getIndexStatus = vi.fn().mockResolvedValue({ indexed: true });
    clearIndex = vi.fn().mockResolvedValue(undefined);
  },
}));

const mockCoordinatorInstances: any[] = [];
vi.mock("../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js", () => ({
  EnrichmentCoordinator: class {
    constructor() {
      mockCoordinatorInstances.push(this);
    }
    runRecovery = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../../../src/core/domains/ingest/pipeline/enrichment/recovery.js", () => ({
  EnrichmentRecovery: class {},
}));

vi.mock("../../../src/core/domains/ingest/pipeline/enrichment/migration.js", () => ({
  EnrichmentMigration: class {},
}));

vi.mock("../../../src/core/domains/ingest/factory.js", () => ({
  createIngestDependencies: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../src/core/domains/trajectory/git/provider.js", () => ({
  GitEnrichmentProvider: class {},
}));

vi.mock("../../../src/core/domains/trajectory/static/provider.js", () => ({
  StaticPayloadBuilder: class {},
}));

vi.mock("../../../src/core/adapters/qdrant/scroll.js", () => ({
  scrollAllPoints: (...args: any[]) => mockScrollAllPoints(...args),
}));

vi.mock("../../../src/core/domains/ingest/collection-stats.js", () => ({
  computeCollectionStats: (...args: any[]) => mockComputeStats(...args),
}));

describe("IngestFacade", () => {
  beforeEach(() => {
    mockCoordinatorInstances.length = 0;
  });

  function makeFacade(opts: { withStats?: boolean; withReranker?: boolean } = {}) {
    const statsCache = opts.withStats ? { save: vi.fn(), load: vi.fn() } : undefined;
    const reranker = opts.withReranker ? { invalidateStats: vi.fn() } : undefined;
    const payloadSignals = opts.withStats ? [{ key: "language", label: "Language" }] : undefined;

    const facade = new IngestFacade(
      {
        collectionExists: vi.fn().mockResolvedValue(false),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      {} as any,
      { enableGitMetadata: false } as any,
      statsCache as any,
      payloadSignals as any,
      reranker as any,
    );

    return { facade, statsCache, reranker };
  }

  it("delegates indexCodebase and refreshes stats", async () => {
    const { facade, statsCache } = makeFacade({ withStats: true, withReranker: true });
    const result = await facade.indexCodebase("/tmp/test-project");
    expect(result).toEqual({ chunksIndexed: 10 });
    expect(statsCache!.save).toHaveBeenCalled();
  });

  it("delegates reindexChanges and refreshes stats", async () => {
    const { facade, statsCache, reranker } = makeFacade({ withStats: true, withReranker: true });
    const result = await facade.reindexChanges("/tmp/test-project");
    expect(result).toEqual({ added: 1, removed: 0 });
    expect(statsCache!.save).toHaveBeenCalled();
    expect(reranker!.invalidateStats).toHaveBeenCalled();
  });

  it("skips refreshStats when no statsCache", async () => {
    mockScrollAllPoints.mockClear();
    const { facade } = makeFacade({ withStats: false });
    await facade.indexCodebase("/tmp/test-project");
    expect(mockScrollAllPoints).not.toHaveBeenCalled();
  });

  it("does not throw when refreshStats fails", async () => {
    mockScrollAllPoints.mockRejectedValueOnce(new Error("qdrant down"));
    const { facade } = makeFacade({ withStats: true, withReranker: true });
    const result = await facade.indexCodebase("/tmp/test-project");
    expect(result).toEqual({ chunksIndexed: 10 });
  });

  it("delegates getIndexStatus with infraHealth", async () => {
    const { facade } = makeFacade();
    const status = await facade.getIndexStatus("/tmp/test-project");
    expect(status).toMatchObject({ indexed: true });
    expect(status.infraHealth).toEqual({
      qdrant: { available: true, url: "http://localhost:6333" },
      embedding: { available: true, provider: "mock" },
    });
  });

  it("delegates clearIndex", async () => {
    const { facade } = makeFacade();
    await expect(facade.clearIndex("/tmp/test-project")).resolves.toBeUndefined();
  });

  it("wires onChunkEnrichmentComplete to refresh stats by collection", async () => {
    mockScrollAllPoints.mockClear();
    mockComputeStats.mockClear();
    const { statsCache, reranker } = makeFacade({ withStats: true, withReranker: true });

    const coordinator = mockCoordinatorInstances[0];
    expect(coordinator.onChunkEnrichmentComplete).toBeTypeOf("function");

    // Simulate chunk enrichment completing
    await coordinator.onChunkEnrichmentComplete("test_collection_abc");

    expect(mockScrollAllPoints).toHaveBeenCalledWith(expect.anything(), "test_collection_abc");
    expect(mockComputeStats).toHaveBeenCalled();
    expect(statsCache!.save).toHaveBeenCalled();
    expect(reranker!.invalidateStats).toHaveBeenCalled();
  });

  it("onChunkEnrichmentComplete does not throw when scroll fails", async () => {
    mockScrollAllPoints.mockClear();
    mockScrollAllPoints.mockRejectedValueOnce(new Error("qdrant down"));
    makeFacade({ withStats: true });

    const coordinator = mockCoordinatorInstances[0];
    await expect(coordinator.onChunkEnrichmentComplete("test_col")).resolves.toBeUndefined();
  });

  it("onChunkEnrichmentComplete is no-op without statsCache", async () => {
    mockScrollAllPoints.mockClear();
    makeFacade({ withStats: false });

    const coordinator = mockCoordinatorInstances[0];
    await coordinator.onChunkEnrichmentComplete("test_col");
    expect(mockScrollAllPoints).not.toHaveBeenCalled();
  });

  it("passes migrations from reindexChanges through incremental indexCodebase", async () => {
    mockReindexChanges.mockResolvedValueOnce({
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 5,
      chunksDeleted: 0,
      durationMs: 100,
      status: "completed",
      migrations: ["v7: Enabled sparse vectors on collection", "Rebuilt sparse vectors (v0 → v1)"],
    });

    const { facade } = makeFacade();
    (facade as any).qdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
    const result = await facade.indexCodebase("/tmp/test-project");

    expect(result.migrations).toEqual(["v7: Enabled sparse vectors on collection", "Rebuilt sparse vectors (v0 → v1)"]);
  });

  it("omits migrations from result when no migrations applied", async () => {
    mockReindexChanges.mockResolvedValueOnce({
      filesAdded: 0,
      filesModified: 0,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 0,
      chunksDeleted: 0,
      durationMs: 50,
      status: "completed",
    });

    const { facade } = makeFacade();
    (facade as any).qdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
    const result = await facade.indexCodebase("/tmp/test-project");

    expect(result.migrations).toBeUndefined();
  });

  describe("getIndexStatus does not require embeddings", () => {
    it("returns status with embedding unavailable when provider is unreachable", async () => {
      const { facade } = makeFacade();
      // Sabotage embed() and checkHealth() to simulate Ollama being down
      (facade as any).embeddings = {
        embed: vi.fn().mockRejectedValue(new OllamaUnavailableError("http://localhost:11434")),
        checkHealth: vi.fn().mockResolvedValue(false),
        getProviderName: vi.fn().mockReturnValue("ollama"),
        getBaseUrl: vi.fn().mockReturnValue("http://localhost:11434"),
        getDimensions: vi.fn().mockReturnValue(384),
        getModel: vi.fn().mockReturnValue("test-model"),
      };

      // Should NOT throw — returns status with infraHealth showing embedding down
      const status = await facade.getIndexStatus("/tmp/test-project");
      expect(status).toMatchObject({ indexed: true });
      expect(status.infraHealth?.embedding.available).toBe(false);
      expect(status.infraHealth?.qdrant.available).toBe(true);
    });
  });

  describe("Error propagation", () => {
    it("propagates OllamaUnavailableError from indexCodebase", async () => {
      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      mockIndexCodebase.mockRejectedValueOnce(ollamaError);

      const { facade } = makeFacade();
      await expect(facade.indexCodebase("/tmp/test-project", { forceReindex: true })).rejects.toThrow(
        OllamaUnavailableError,
      );
    });

    it("propagates OllamaUnavailableError from reindexChanges (via indexCodebase auto-detect)", async () => {
      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      mockReindexChanges.mockRejectedValueOnce(ollamaError);

      const { facade } = makeFacade();
      // collectionExists=true → goes to reindexChanges path
      (facade as any).qdrant = { collectionExists: vi.fn().mockResolvedValue(true) };
      await expect(facade.indexCodebase("/tmp/test-project")).rejects.toThrow(OllamaUnavailableError);
    });

    it("propagates OllamaUnavailableError from reindexChanges", async () => {
      const ollamaError = new OllamaUnavailableError("http://192.168.1.71:11434");
      mockReindexChanges.mockRejectedValueOnce(ollamaError);

      const { facade } = makeFacade();
      await expect(facade.reindexChanges("/tmp/test-project")).rejects.toThrow(OllamaUnavailableError);
    });
  });
});
