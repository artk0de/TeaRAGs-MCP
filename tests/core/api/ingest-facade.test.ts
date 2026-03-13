import { describe, expect, it, vi } from "vitest";

import { IngestFacade } from "../../../src/core/api/internal/facades/ingest-facade.js";

const { mockIndexCodebase, mockReindexChanges, mockScrollAllPoints, mockComputeStats } = vi.hoisted(() => ({
  mockIndexCodebase: vi.fn().mockResolvedValue({ chunksIndexed: 10 }),
  mockReindexChanges: vi.fn().mockResolvedValue({ added: 1, removed: 0 }),
  mockScrollAllPoints: vi.fn().mockResolvedValue([]),
  mockComputeStats: vi.fn().mockReturnValue({ computedAt: Date.now(), perSignal: new Map() }),
}));

vi.mock("../../../src/core/ingest/indexing.js", () => ({
  IndexPipeline: class {
    indexCodebase = mockIndexCodebase;
  },
}));

vi.mock("../../../src/core/ingest/reindexing.js", () => ({
  ReindexPipeline: class {
    reindexChanges = mockReindexChanges;
  },
}));

vi.mock("../../../src/core/ingest/pipeline/status-module.js", () => ({
  StatusModule: class {
    getIndexStatus = vi.fn().mockResolvedValue({ indexed: true });
    clearIndex = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../../../src/core/ingest/pipeline/enrichment/coordinator.js", () => ({
  EnrichmentCoordinator: class {},
}));

vi.mock("../../../src/core/ingest/factory.js", () => ({
  createIngestDependencies: vi.fn().mockReturnValue({}),
}));

vi.mock("../../../src/core/trajectory/git/provider.js", () => ({
  GitEnrichmentProvider: class {},
}));

vi.mock("../../../src/core/trajectory/static/provider.js", () => ({
  StaticPayloadBuilder: class {},
}));

vi.mock("../../../src/core/adapters/qdrant/scroll.js", () => ({
  scrollAllPoints: (...args: any[]) => mockScrollAllPoints(...args),
}));

vi.mock("../../../src/core/ingest/collection-stats.js", () => ({
  computeCollectionStats: (...args: any[]) => mockComputeStats(...args),
}));

describe("IngestFacade", () => {
  function makeFacade(opts: { withStats?: boolean; withReranker?: boolean } = {}) {
    const statsCache = opts.withStats ? { save: vi.fn(), load: vi.fn() } : undefined;
    const reranker = opts.withReranker ? { invalidateStats: vi.fn() } : undefined;
    const payloadSignals = opts.withStats ? [{ key: "language", label: "Language" }] : undefined;

    const facade = new IngestFacade(
      {} as any,
      {} as any,
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

  it("delegates getIndexStatus", async () => {
    const { facade } = makeFacade();
    const status = await facade.getIndexStatus("/tmp/test-project");
    expect(status).toEqual({ indexed: true });
  });

  it("delegates clearIndex", async () => {
    const { facade } = makeFacade();
    await expect(facade.clearIndex("/tmp/test-project")).resolves.toBeUndefined();
  });
});
