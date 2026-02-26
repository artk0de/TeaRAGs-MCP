import ignore from "ignore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EnrichmentCoordinator } from "../../../../../src/core/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../src/core/ingest/pipeline/enrichment/types.js";

describe("EnrichmentCoordinator", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;
  let coordinator: EnrichmentCoordinator;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
  });

  it("has provider keys accessible", () => {
    expect(coordinator.providerKeys).toEqual(["git"]);
  });

  it("calls provider.resolveRoot and buildFileSignals on prefetch", () => {
    coordinator.prefetch("/repo", "test-col");
    expect(mockProvider.resolveRoot).toHaveBeenCalledWith("/repo");
    expect(mockProvider.buildFileSignals).toHaveBeenCalledWith("/repo");
  });

  it("delegates .git check to provider (coordinator is generic)", () => {
    // Provider returns empty map for non-git paths
    (mockProvider.buildFileSignals as any).mockResolvedValue(new Map());
    coordinator.prefetch("/some-path", "test-col");
    expect(mockProvider.resolveRoot).toHaveBeenCalled();
    expect(mockProvider.buildFileSignals).toHaveBeenCalled();
  });

  it("queues batches when prefetch is pending, flushes when ready", async () => {
    // Make buildFileSignals slow
    let resolvePrefetch: (v: Map<string, Record<string, unknown>>) => void;
    (mockProvider.buildFileSignals as any).mockReturnValue(
      new Promise((resolve) => {
        resolvePrefetch = resolve;
      }),
    );

    coordinator.prefetch("/repo", "test-col");

    // Queue a batch while prefetch is pending
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    // No Qdrant calls yet (batch is queued)
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();

    // Resolve prefetch
    resolvePrefetch!(new Map([["src/a.ts", { someData: true }]]));

    // Wait for flush
    await new Promise((r) => setTimeout(r, 10));

    // Now batchSetPayload should have been called (flush applied the queued batch)
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
  });

  it("applies immediately when prefetch is already done", async () => {
    // Fast prefetch
    (mockProvider.buildFileSignals as any).mockResolvedValue(new Map([["src/a.ts", { x: 1 }]]));

    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
  });

  it("startChunkEnrichment calls provider.buildChunkSignals", () => {
    coordinator.prefetch("/repo", "test-col");
    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith("/repo", chunkMap);
  });

  it("awaitCompletion returns metrics", async () => {
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics).toHaveProperty("prefetchDurationMs");
    expect(metrics).toHaveProperty("totalDurationMs");
    expect(metrics).toHaveProperty("matchedFiles");
    expect(metrics).toHaveProperty("missedFiles");
  });

  it("handles multiple providers in parallel", async () => {
    const providerA: EnrichmentProvider = {
      key: "alpha",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { a: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const providerB: EnrichmentProvider = {
      key: "beta",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { b: 2 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const multi = new EnrichmentCoordinator(mockQdrant, [providerA, providerB]);

    multi.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    expect(providerA.buildFileSignals).toHaveBeenCalledWith("/repo");
    expect(providerB.buildFileSignals).toHaveBeenCalledWith("/repo");
    expect(multi.providerKeys).toEqual(["alpha", "beta"]);
  });

  it("is a no-op when no providers are registered", async () => {
    const empty = new EnrichmentCoordinator(mockQdrant, []);

    empty.prefetch("/repo", "test-col");
    empty.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    const metrics = await empty.awaitCompletion("test-col");
    expect(metrics).toHaveProperty("totalDurationMs");
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
  });
});

describe("EnrichmentCoordinator — prefetch with ignoreFilter", () => {
  let mockQdrant: any;
  let mockProvider: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn(),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
  });

  it("filters paths matching ignoreFilter before applying metadata", async () => {
    const ignoreFilter = ignore().add(["*.md"]);

    const fileMetaMap = new Map([
      ["src/a.ts", { data: 1 }],
      ["README.md", { data: 2 }],
    ]);
    mockProvider.buildFileSignals.mockResolvedValue(fileMetaMap);

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col", ignoreFilter);

    await new Promise((r) => setTimeout(r, 20));

    // Apply a batch — only src/a.ts should match (README.md was filtered)
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();
  });

  it("sets prefetchFailed=true and clears pending batches on error", async () => {
    mockProvider.buildFileSignals.mockRejectedValue(new Error("git fail"));

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    // Queue a batch BEFORE prefetch resolves
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 5 } } as any,
    ]);

    await new Promise((r) => setTimeout(r, 20));

    // No Qdrant calls because prefetch failed
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();

    // awaitCompletion still returns valid metrics (zeroed)
    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics.prefetchDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.streamingApplies).toBe(0);
    expect(metrics.flushApplies).toBe(0);
  });

  it("skips onChunksStored processing when prefetchFailed", async () => {
    mockProvider.buildFileSignals.mockRejectedValue(new Error("fail"));
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo");
    await new Promise((r) => setTimeout(r, 10));

    // After failure, onChunksStored should be a no-op
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/f.ts" }, endLine: 5 } } as any,
    ]);
    expect(mockQdrant.batchSetPayload).not.toHaveBeenCalled();
  });
});

describe("EnrichmentCoordinator — startChunkEnrichment", () => {
  let mockQdrant: any;
  let mockProvider: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map([["c1", { commitCount: 5 }]])),
    };
  });

  it("calls buildChunkSignals and applies overlays", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith("/repo", chunkMap);
  });

  it("skips chunk enrichment when prefetchFailed", async () => {
    mockProvider.buildFileSignals.mockRejectedValue(new Error("fail"));
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();
  });
});

describe("EnrichmentCoordinator — updateEnrichmentMarker", () => {
  it("calls qdrant.setPayload with enrichment info", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    await coordinator.updateEnrichmentMarker("test-col", { status: "in_progress" });
    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "test-col",
      { enrichment: { status: "in_progress" } },
      expect.any(Object),
    );
  });

  it("computes percentage when totalFiles and processedFiles are set", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    await coordinator.updateEnrichmentMarker("test-col", { totalFiles: 100, processedFiles: 50 });
    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "test-col",
      { enrichment: expect.objectContaining({ percentage: 50 }) },
      expect.any(Object),
    );
  });

  it("silently ignores setPayload errors", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockRejectedValue(new Error("qdrant down")),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    // Should not throw
    await expect(coordinator.updateEnrichmentMarker("test-col", { status: "completed" })).resolves.toBeUndefined();
  });
});

describe("EnrichmentCoordinator — awaitCompletion metrics", () => {
  it("returns aggregated metrics across multiple providers", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    const providerA: any = {
      key: "provA",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["f1.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const providerB: any = {
      key: "provB",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["f2.ts", { y: 2 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, [providerA, providerB]);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics.gitLogFileCount).toBe(2); // 1 from each provider
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(metrics.prefetchDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("computes overlap timing when pipelineFlushTime is set", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    // Trigger pipelineFlushTime by storing chunks
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics.overlapMs).toBeGreaterThanOrEqual(0);
    expect(metrics.overlapRatio).toBeGreaterThanOrEqual(0);
    expect(metrics.overlapRatio).toBeLessThanOrEqual(1);
  });
});
