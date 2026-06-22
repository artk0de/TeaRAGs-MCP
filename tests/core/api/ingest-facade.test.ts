import { beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaUnavailableError } from "../../../src/core/adapters/embeddings/ollama/errors.js";
import { IngestFacade } from "../../../src/core/api/internal/facades/ingest-facade.js";

const { mockIndexCodebase, mockReindexChanges, mockScrollAllPoints, mockComputeStats } = vi.hoisted(() => ({
  mockIndexCodebase: vi.fn().mockResolvedValue({ chunksIndexed: 10 }),
  mockReindexChanges: vi.fn().mockResolvedValue({ added: 1, removed: 0 }),
  mockScrollAllPoints: vi.fn().mockResolvedValue([]),
  mockComputeStats: vi.fn().mockReturnValue({ computedAt: Date.now(), perSignal: new Map() }),
}));

vi.mock("../../../src/core/domains/ingest/operations/indexing.js", () => ({
  IndexPipeline: class {
    indexCodebase = mockIndexCodebase;
  },
}));

vi.mock("../../../src/core/domains/ingest/operations/reindexing.js", () => ({
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
    public providers: any[];
    constructor(_qdrant: any, providers: any[]) {
      this.providers = providers;
      mockCoordinatorInstances.push(this);
    }
    runRecovery = vi.fn().mockResolvedValue(undefined);
    setEnrichmentProgress = vi.fn();
    whenComplete = vi.fn().mockResolvedValue(undefined);
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

vi.mock("../../../src/core/domains/ingest/infra/collection-stats.js", () => ({
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

    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(false),
      checkHealth: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn().mockResolvedValue({
        name: "test_col",
        vectorSize: 384,
        pointsCount: 0,
        distance: "Cosine" as const,
        hybridEnabled: false,
        status: "green" as const,
        optimizerStatus: "ok",
      }),
      // Alias lookup is used by the post-enrichment stats refresh wiring to
      // translate target collection name (e.g. "code_v2") to its public alias
      // (e.g. "code") so stats are saved under the name that get_index_metrics
      // reads. Default returns no aliases — incremental case where target == alias.
      aliases: {
        listAliases: vi.fn().mockResolvedValue([]),
      },
      url: "http://localhost:6333",
    };

    const facade = new IngestFacade({
      qdrant: qdrant as any,
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

    return { facade, statsCache, reranker, qdrant };
  }

  // Registry-driven IngestFacade refactor: enrichment providers are now
  // owned upstream (bootstrap reads them from TrajectoryRegistry). The
  // facade trusts the list as-is and forwards it to EnrichmentCoordinator
  // verbatim — no inline construction, no config-aware filtering. This
  // pins both halves of the contract: deps.enrichmentProviders flows
  // straight through, AND IngestFacade does NOT synthesize a git provider
  // when the list is empty.
  it("forwards deps.enrichmentProviders to EnrichmentCoordinator verbatim", () => {
    const stubA = { key: "stubA" } as any;
    const stubB = { key: "stubB" } as any;
    new IngestFacade({
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      embeddings: {
        embed: vi.fn(),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: true } as any,
      enrichmentProviders: [stubA, stubB],
    });
    const coordinator = mockCoordinatorInstances.at(-1);
    expect(coordinator.providers).toEqual([stubA, stubB]);
  });

  it("registers zero providers when enrichmentProviders omitted (no inline git construction)", () => {
    new IngestFacade({
      qdrant: {
        collectionExists: vi.fn().mockResolvedValue(false),
        checkHealth: vi.fn().mockResolvedValue(true),
        url: "http://localhost:6333",
      } as any,
      embeddings: {
        embed: vi.fn(),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("mock"),
      } as any,
      config: {} as any,
      // Even with enableGitMetadata: true, the facade no longer constructs
      // a GitEnrichmentProvider inline — bootstrap owns that decision now.
      trajectoryConfig: { enableGitMetadata: true } as any,
    });
    const coordinator = mockCoordinatorInstances.at(-1);
    expect(coordinator.providers).toEqual([]);
  });

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

  it("delegates getIndexStatus with infraHealth including Qdrant collection status", async () => {
    const { facade, qdrant } = makeFacade();
    qdrant.collectionExists.mockResolvedValue(true);
    const status = await facade.getIndexStatus("/tmp/test-project");
    expect(status).toMatchObject({ indexed: true });
    expect(status.infraHealth).toEqual({
      qdrant: {
        available: true,
        url: "http://localhost:6333",
        status: "green",
        optimizerStatus: "ok",
      },
      embedding: { available: true, provider: "mock" },
    });
  });

  it("surfaces yellow collection status through infraHealth.qdrant", async () => {
    const { facade, qdrant } = makeFacade();
    qdrant.collectionExists.mockResolvedValue(true);
    qdrant.getCollectionInfo.mockResolvedValue({
      name: "test_col",
      vectorSize: 384,
      pointsCount: 100,
      distance: "Cosine" as const,
      hybridEnabled: false,
      status: "yellow" as const,
      optimizerStatus: "ok",
    });

    const status = await facade.getIndexStatus("/tmp/test-project");
    expect(status.infraHealth?.qdrant.status).toBe("yellow");
    expect(status.infraHealth?.qdrant.optimizerStatus).toBe("ok");
  });

  it("omits status fields from infraHealth when collection does not yet exist", async () => {
    const { facade } = makeFacade();
    const status = await facade.getIndexStatus("/tmp/test-project");
    expect(status.infraHealth?.qdrant.status).toBeUndefined();
    expect(status.infraHealth?.qdrant.optimizerStatus).toBeUndefined();
  });

  it("surfaces embedding url + fallbackUrl through infraHealth when the provider exposes both getters", async () => {
    // Symmetric with infraHealth.qdrant.url: the prime CLI digest, and any
    // downstream tooling reading IndexStatus.infraHealth.embedding, must see
    // BOTH endpoints when the EmbeddingProvider (Ollama with EMBEDDING_FALLBACK_URL
    // configured) exposes them. Built inline to avoid touching makeFacade.
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(false),
      checkHealth: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn(),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      url: "http://localhost:6333",
    };
    const facade = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("ollama"),
        getBaseUrl: vi.fn().mockReturnValue("http://gpu-server:11434"),
        getFallbackBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434"),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: false } as any,
    });

    const status = await facade.getIndexStatus("/tmp/test-project");

    expect(status.infraHealth?.embedding).toEqual({
      available: true,
      provider: "ollama",
      url: "http://gpu-server:11434",
      fallbackUrl: "http://127.0.0.1:11434",
    });
  });

  it("omits embedding.fallbackUrl when getFallbackBaseUrl returns undefined", async () => {
    // Backward compatibility: providers that don't expose a fallback (ONNX,
    // Voyage, Ollama without EMBEDDING_FALLBACK_URL) must not emit the field
    // at all — the prime CLI gates the `· fallback: <url>` segment on its
    // presence.
    const qdrant = {
      collectionExists: vi.fn().mockResolvedValue(false),
      checkHealth: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn(),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      url: "http://localhost:6333",
    };
    const facade = new IngestFacade({
      qdrant: qdrant as any,
      embeddings: {
        embed: vi.fn().mockResolvedValue({ embedding: [0.1], dimensions: 1 }),
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: vi.fn().mockReturnValue("ollama"),
        getBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:11434"),
        getFallbackBaseUrl: vi.fn().mockReturnValue(undefined),
      } as any,
      config: {} as any,
      trajectoryConfig: { enableGitMetadata: false } as any,
    });

    const status = await facade.getIndexStatus("/tmp/test-project");

    expect(status.infraHealth?.embedding).toEqual({
      available: true,
      provider: "ollama",
      url: "http://127.0.0.1:11434",
    });
    expect(status.infraHealth?.embedding).not.toHaveProperty("fallbackUrl");
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

  // Regression for forceReindex stats-stale bug: forceReindex creates a NEW
  // versioned target collection (e.g. "code_v2") and only swaps the public
  // alias ("code") to point at it after indexing. EnrichmentCoordinator fires
  // onChunkEnrichmentComplete with the TARGET name. Without target→alias
  // translation, stats are saved under "code_v2.stats.json" — a file that
  // get_index_metrics never reads (it loads "code.stats.json"). Result: stats
  // appear permanently stale to the user after every forceReindex.
  it("saves stats under public alias when callback receives target collection name (forceReindex)", async () => {
    mockScrollAllPoints.mockClear();
    mockComputeStats.mockClear();
    const { statsCache, qdrant } = makeFacade({ withStats: true, withReranker: true });
    qdrant.aliases.listAliases.mockResolvedValue([{ aliasName: "code", collectionName: "code_v2" }]);

    const coordinator = mockCoordinatorInstances[0];
    await coordinator.onChunkEnrichmentComplete("code_v2");

    expect(statsCache!.save).toHaveBeenCalledWith("code", expect.anything(), expect.anything());
  });

  // Regression guard for incremental indexing path: target == alias (no
  // versioned collection created), listAliases returns no entry mapping to
  // this name, so save uses the name as-is. Locks "single canonical save key"
  // behavior so future refactors of forceReindex don't accidentally regress
  // incremental.
  it("saves stats under same name when no alias points to the target (incremental)", async () => {
    mockScrollAllPoints.mockClear();
    mockComputeStats.mockClear();
    const { statsCache, qdrant } = makeFacade({ withStats: true, withReranker: true });
    qdrant.aliases.listAliases.mockResolvedValue([]);

    const coordinator = mockCoordinatorInstances[0];
    await coordinator.onChunkEnrichmentComplete("code");

    expect(statsCache!.save).toHaveBeenCalledWith("code", expect.anything(), expect.anything());
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
      // Sabotage embeddings on the extracted IndexingOps (per facade-discipline
      // iter-2 test anti-pattern note: post-construction swap goes on the ops class).
      (facade as any).indexingOps.embeddings = {
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

    it("caps user chunkSize to defaultChunkSize (with safety factor) when exceeding it", () => {
      const facade = makeFacadeWithConfig({ chunkSize: 8000, userSetChunkSize: true });
      const modelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      // maxAllowed = 4096, default = floor(4096 * 0.8) = 3276
      // 8000 > 3276 → cap to 3276 so safety factor still applies
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(3276);
    });

    it("caps user chunkSize even when userSet is between default and maxAllowed", () => {
      // Real-world: CODE_CHUNK_SIZE=4500 + nomic-embed-text (ctx=2048).
      // maxAllowed=4096, default=3276. 4500 between them previously slipped
      // through unsplit and overflowed Ollama on dense markdown.
      const facade = makeFacadeWithConfig({ chunkSize: 4500, userSetChunkSize: true });
      const modelInfo = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
      expect(facade.resolveEffectiveChunkSize(modelInfo)).toBe(3276);
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

  describe("pre-reindex recovery ordering (8tp8)", () => {
    it("awaits recovery BEFORE reindexChanges so the degraded marker is cleared", async () => {
      // Regression: dispatchRecovery used to be fire-and-forget, launched right
      // before reindexChanges. Recovery re-enriches stale (unenriched) points,
      // but it lost the race against the reindex's markFileFinal/markChunkFinal,
      // which re-derives status from countUnenriched while recovery was still
      // running → degraded stuck forever. Sequencing recovery FIRST guarantees
      // the payload re-enrichment lands before the reindex finalizes its count.
      let recoveryResolved = false;
      let reindexSawRecoveryDone: boolean | undefined;

      mockReindexChanges.mockImplementationOnce(async () => {
        reindexSawRecoveryDone = recoveryResolved;
        return { added: 0, removed: 0 };
      });

      // collectionExists=true → incremental (reindex) path.
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

      // Recovery takes real time and flips the flag only when it completes.
      const coordinator = mockCoordinatorInstances.at(-1);
      coordinator.runRecovery = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 20));
        recoveryResolved = true;
      });

      await facade.indexCodebase("/tmp/test-project");

      expect(coordinator.runRecovery).toHaveBeenCalledTimes(1);
      // The fix: reindex must observe recovery as already finished.
      expect(reindexSawRecoveryDone).toBe(true);
    });

    it("a failing recovery is logged but does not block the reindex", async () => {
      // Errors must no longer be silently swallowed by an empty .catch(()=>{}),
      // nor may they break indexing — recovery is best-effort.
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      mockReindexChanges.mockResolvedValueOnce({ added: 1, removed: 0 });

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

      const coordinator = mockCoordinatorInstances.at(-1);
      coordinator.runRecovery = vi.fn().mockRejectedValue(new Error("recovery scroll failed"));

      // Reindex still completes despite the recovery failure.
      await expect(facade.indexCodebase("/tmp/test-project")).resolves.toBeDefined();
      expect(mockReindexChanges).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
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
