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

    const facade = new IngestFacade({
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      embeddings: {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: false } as any,
      statsCache: statsCache as any,
      allPayloadSignals: payloadSignals as any,
      reranker: reranker as any,
    });

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

    const facade = new IngestFacade({
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      embeddings: {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: false } as any,
    });
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

    const facade = new IngestFacade({
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(true),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      embeddings: {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: false } as any,
    });
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

  describe("resolveEffectiveChunkSize", () => {
    function makeFacadeWithConfig(config: { chunkSize: number; userSetChunkSize?: boolean }) {
      const facade = new IngestFacade({
        qdrant: { collectionExists: vi.fn(), checkHealth: vi.fn(), url: "http://localhost:6333" } as any,
        embeddings: { embed: vi.fn(), checkHealth: vi.fn(), getProviderName: vi.fn() } as any,
        config: config as any,
        trajectoryConfig: { enableGitMetadata: false } as any,
      });
      return facade;
    }

    it("returns config chunkSize when modelInfo is absent", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 2500 });
      expect(facade.resolveEffectiveChunkSize(undefined)).toBe(2500);
    });

    it("derives default chunkSize from modelInfo when user did not set chunkSize", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 2500, userSetChunkSize: false });
      const modelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      // maxAllowed = 2048 * 2 = 4096, default = floor(4096 * 0.8) = 3276
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(3276);
    });

    it("keeps user chunkSize when within model limit", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 3000, userSetChunkSize: true });
      const modelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      // maxAllowed = 4096, 3000 < 4096 → keep 3000
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(3000);
    });

    it("caps user chunkSize to maxAllowed when exceeding model limit", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 8000, userSetChunkSize: true });
      const modelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      // maxAllowed = 4096, 8000 > 4096 → cap to 4096
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(4096);
    });

    it("uses model-derived default for small context models", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 2500 });
      const modelInfo = { model: "all-minilm", contextLength: 512, dimensions: 384 };
      // maxAllowed = 512 * 2 = 1024, default = floor(1024 * 0.8) = 819
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(819);
    });
  });

  describe("modelInfo from marker on re-index", () => {
    const defaultReindexResult = {
      filesAdded: 0,
      filesModified: 1,
      filesDeleted: 0,
      filesNewlyIgnored: 0,
      filesNewlyUnignored: 0,
      chunksAdded: 2,
      chunksDeleted: 0,
      durationMs: 50,
      status: "completed",
    };

    function makeReindexFacade(opts: {
      markerPayload?: Record<string, unknown> | null;
      resolveModelInfo?: () => Promise<any>;
    }) {
      const getPoint = vi
        .fn()
        .mockResolvedValue(opts.markerPayload !== null ? { payload: opts.markerPayload ?? {} } : null);
      const setPayload = vi.fn().mockResolvedValue(undefined);
      const resolveModelInfoMock = opts.resolveModelInfo ?? vi.fn().mockResolvedValue(undefined);

      const facade = new IngestFacade({
        qdrant: {
          collectionExists: vi.fn().mockResolvedValue(true),
          checkHealth: vi.fn().mockResolvedValue(true),
          getPoint,
          setPayload,
          url: "http://localhost:6333",
        } as any,
        embeddings: {
          embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: vi.fn().mockReturnValue("mock"),
          resolveModelInfo: resolveModelInfoMock,
        } as any,
        config: { chunkSize: 2500 } as any,
        trajectoryConfig: { enableGitMetadata: false } as any,
      });

      return { facade, getPoint, setPayload, resolveModelInfoMock };
    }

    it("uses modelInfo from existing marker and skips Ollama query", async () => {
      const markerModelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      const resolveModelInfoMock = vi.fn();
      mockReindexChanges.mockResolvedValueOnce(defaultReindexResult);

      const { facade, getPoint } = makeReindexFacade({
        markerPayload: {
          indexingComplete: true,
          embeddingModel: "nomic-embed-text",
          modelInfo: markerModelInfo,
        },
        resolveModelInfo: resolveModelInfoMock,
      });

      await facade.indexCodebase("/tmp/test-project");

      expect(getPoint).toHaveBeenCalled();
      expect(resolveModelInfoMock).not.toHaveBeenCalled();
    });

    it("queries Ollama and backfills marker when marker has no modelInfo (legacy)", async () => {
      const ollamaModelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      const resolveModelInfoMock = vi.fn().mockResolvedValue(ollamaModelInfo);
      mockReindexChanges.mockResolvedValueOnce(defaultReindexResult);

      const { facade, setPayload } = makeReindexFacade({
        markerPayload: {
          indexingComplete: true,
          embeddingModel: "nomic-embed-text",
        },
        resolveModelInfo: resolveModelInfoMock,
      });

      await facade.indexCodebase("/tmp/test-project");

      expect(resolveModelInfoMock).toHaveBeenCalled();
      expect(setPayload).toHaveBeenCalledWith(
        expect.any(String),
        { modelInfo: ollamaModelInfo },
        { points: [expect.any(String)] },
      );
    });

    it("queries Ollama on fresh index (no existing collection)", async () => {
      const ollamaModelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      const resolveModelInfoMock = vi.fn().mockResolvedValue(ollamaModelInfo);

      const facade = new IngestFacade({
        qdrant: {
          collectionExists: vi.fn().mockResolvedValue(false),
          checkHealth: vi.fn().mockResolvedValue(true),
          getPoint: vi.fn(),
          setPayload: vi.fn(),
          url: "http://localhost:6333",
        } as any,
        embeddings: {
          embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: vi.fn().mockReturnValue("mock"),
          resolveModelInfo: resolveModelInfoMock,
        } as any,
        config: { chunkSize: 2500 } as any,
        trajectoryConfig: { enableGitMetadata: false } as any,
      });

      await facade.indexCodebase("/tmp/test-project");

      // Fresh index always queries Ollama (no marker to read)
      expect(resolveModelInfoMock).toHaveBeenCalled();
    });

    it("does not backfill marker when Ollama returns no modelInfo", async () => {
      const resolveModelInfoMock = vi.fn().mockResolvedValue(undefined);
      mockReindexChanges.mockResolvedValueOnce(defaultReindexResult);

      const { facade, setPayload } = makeReindexFacade({
        markerPayload: { indexingComplete: true },
        resolveModelInfo: resolveModelInfoMock,
      });

      await facade.indexCodebase("/tmp/test-project");

      expect(resolveModelInfoMock).toHaveBeenCalled();
      // setPayload should NOT be called for backfill (only for other purposes)
      expect(setPayload).not.toHaveBeenCalled();
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

      // collectionExists=true → goes to reindexChanges path
      const facade = new IngestFacade({
        qdrant: {
          collectionExists: vi.fn().mockResolvedValue(true),
          checkHealth: vi.fn().mockResolvedValue(true),
          url: "http://localhost:6333",
        } as any,
        embeddings: {
          embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
          checkHealth: vi.fn().mockResolvedValue(true),
          getProviderName: vi.fn().mockReturnValue("mock"),
        } as any,
        config: {} as any,
        trajectoryConfig: { enableGitMetadata: false } as any,
      });
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
