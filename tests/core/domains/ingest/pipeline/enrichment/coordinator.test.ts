import ignore from "ignore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";

describe("EnrichmentCoordinator", () => {
  let mockQdrant: any;
  let mockProvider: EnrichmentProvider;
  let coordinator: EnrichmentCoordinator;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    mockProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
  });

  it("has provider keys accessible", () => {
    expect(coordinator.providerKeys).toEqual(["git"]);
  });

  it("providerKey returns first key (deprecated)", () => {
    expect(coordinator.providerKey).toBe("git");
  });

  it("providerKey returns empty string when no providers", () => {
    const empty = new EnrichmentCoordinator(mockQdrant, []);
    expect(empty.providerKey).toBe("");
  });

  it("logs when provider resolveRoot differs from absolutePath", async () => {
    const divergentProvider: EnrichmentProvider = {
      ...mockProvider,
      resolveRoot: vi.fn(() => "/git-root"),
    };
    const coord = new EnrichmentCoordinator(mockQdrant, divergentProvider);
    coord.prefetch("/sub/path", "test-col");
    expect(divergentProvider.resolveRoot).toHaveBeenCalledWith("/sub/path");
    // Provider uses /git-root, absolutePath is /sub/path → REPO_ROOT_DIFFERS logged
    await new Promise((r) => setTimeout(r, 10));
    expect(divergentProvider.buildFileSignals).toHaveBeenCalledWith("/git-root", undefined);
  });

  it("calls provider.resolveRoot and buildFileSignals on prefetch", () => {
    coordinator.prefetch("/repo", "test-col");
    expect(mockProvider.resolveRoot).toHaveBeenCalledWith("/repo");
    expect(mockProvider.buildFileSignals).toHaveBeenCalledWith("/repo", undefined);
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
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { a: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const providerB: EnrichmentProvider = {
      key: "beta",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { b: 2 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const multi = new EnrichmentCoordinator(mockQdrant, [providerA, providerB]);

    multi.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    expect(providerA.buildFileSignals).toHaveBeenCalledWith("/repo", undefined);
    expect(providerB.buildFileSignals).toHaveBeenCalledWith("/repo", undefined);
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
      getPoint: vi.fn().mockResolvedValue(null),
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
      getPoint: vi.fn().mockResolvedValue(null),
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

  it("filters chunkMap paths by ignoreFilter", async () => {
    const ignoreFilter = ignore().add(["*.md"]);
    mockProvider.buildChunkSignals.mockResolvedValue(new Map());

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col", ignoreFilter);
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([
      ["/repo/src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
      ["/repo/README.md", [{ chunkId: "c2", startLine: 1, endLine: 5 }]],
    ]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 20));
    // buildChunkSignals should receive filtered map (only .ts, not .md)
    const calledMap = mockProvider.buildChunkSignals.mock.calls[0][1] as Map<string, unknown>;
    expect(calledMap.size).toBe(1);
    expect(calledMap.has("/repo/src/a.ts")).toBe(true);
    expect(calledMap.has("/repo/README.md")).toBe(false);
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
  it("calls qdrant.setPayload with per-provider enrichment marker", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    await coordinator.updateEnrichmentMarker("test-col", {
      git: { file: { status: "in_progress", unenrichedChunks: 0 } },
    });
    expect(mockQdrant.setPayload).toHaveBeenCalledWith(
      "test-col",
      { enrichment: { git: { file: { status: "in_progress", unenrichedChunks: 0 } } } },
      expect.any(Object),
    );
  });

  it("deep-merges per-provider markers preserving existing fields", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue({
        payload: {
          enrichment: {
            git: {
              runId: "abc",
              file: { status: "in_progress", startedAt: "2026-01-01T00:00:00Z", unenrichedChunks: 5 },
              chunk: { status: "pending", unenrichedChunks: 0 },
            },
          },
        },
      }),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    await coordinator.updateEnrichmentMarker("test-col", {
      git: { file: { status: "completed", completedAt: "2026-01-01T00:01:00Z", unenrichedChunks: 0 } },
    });

    const written = mockQdrant.setPayload.mock.calls[0][1].enrichment;
    // Should preserve runId and chunk from existing, merge file fields
    expect(written.git.runId).toBe("abc");
    expect(written.git.file.status).toBe("completed");
    expect(written.git.file.startedAt).toBe("2026-01-01T00:00:00Z"); // preserved from existing
    expect(written.git.file.completedAt).toBe("2026-01-01T00:01:00Z"); // new
    expect(written.git.chunk.status).toBe("pending"); // preserved
  });

  it("silently ignores setPayload errors", async () => {
    const mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockRejectedValue(new Error("qdrant down")),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);

    // Should not throw
    await expect(
      coordinator.updateEnrichmentMarker("test-col", {
        git: { file: { status: "completed", unenrichedChunks: 0 } },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("EnrichmentCoordinator — backfill missed files", () => {
  let mockQdrant: any;
  let mockProvider: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
  });

  it("backfills missed files with batch operations during awaitCompletion", async () => {
    // Provider returns metadata only for file "src/a.ts", not "src/missing.ts"
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map([["src/a.ts", { x: 1 }]])) // initial prefetch — missing.ts not here
        .mockResolvedValueOnce(new Map([["src/missing.ts", { backfilled: true }]])), // backfill call
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Store chunks for both files — src/missing.ts will be "missed"
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
      { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/missing.ts" }, endLine: 20 } } as any,
    ]);

    await new Promise((r) => setTimeout(r, 20));

    const metrics = await coordinator.awaitCompletion("test-col");

    // buildFileSignals called twice: prefetch + backfill
    expect(mockProvider.buildFileSignals).toHaveBeenCalledTimes(2);
    expect(mockProvider.buildFileSignals).toHaveBeenLastCalledWith("/repo", { paths: ["src/missing.ts"] });

    // Backfilled file should be written via batchSetPayload
    // At least 2 calls: one for initial apply, one for backfill
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();

    // Metrics should reflect backfill: matchedFiles includes backfilled
    expect(metrics.matchedFiles).toBeGreaterThanOrEqual(1);
  });

  it("handles batchSetPayload error during backfill gracefully", async () => {
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map()) // initial prefetch — all files missed
        .mockResolvedValueOnce(new Map([["src/missed.ts", { recovered: true }]])), // backfill
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/missed.ts" }, endLine: 15 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    // Make batchSetPayload fail on backfill batch
    // First call was for initial apply (empty, so may not be called). Set all future calls to fail.
    mockQdrant.batchSetPayload.mockRejectedValue(new Error("backfill batch error"));

    // Should not throw — error is caught internally
    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics).toHaveProperty("totalDurationMs");
    expect(metrics.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles buildFileSignals failure during backfill gracefully", async () => {
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map()) // initial prefetch — all missed
        .mockRejectedValueOnce(new Error("backfill git fail")), // backfill fails
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/missed.ts" }, endLine: 10 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    // Should not throw — backfill failure is caught
    const metrics = await coordinator.awaitCompletion("test-col");
    expect(metrics.missedFiles).toBeGreaterThanOrEqual(1);
  });

  it("backfills with batching when operations exceed BATCH_SIZE", async () => {
    // Create 150 missed chunks across one file to trigger batch splitting in backfill
    const missedChunks: any[] = [];
    for (let i = 0; i < 150; i++) {
      missedChunks.push({
        chunkId: `c-${i}`,
        chunk: { metadata: { filePath: "/repo/src/big.ts" }, endLine: i + 1 },
      });
    }

    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map()) // prefetch: no files → all missed
        .mockResolvedValueOnce(new Map([["src/big.ts", { recovered: true }]])), // backfill
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", missedChunks);
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // Backfill should produce 150 operations → 2 batches (100 + 50)
    // Filter batchSetPayload calls to only backfill batches (contain "recovered" payload, not just enrichedAt)
    const backfillCalls = mockQdrant.batchSetPayload.mock.calls.filter((call: any[]) => {
      const ops = call[1];
      return ops.length > 0 && ops[0].payload?.git?.file?.recovered === true;
    });
    expect(backfillCalls.length).toBeGreaterThanOrEqual(2);

    // Verify total operations across backfill calls sum to 150
    const totalOps = backfillCalls.reduce((sum: number, call: any[]) => sum + call[1].length, 0);
    expect(totalOps).toBe(150);
  });
});

describe("EnrichmentCoordinator — onChunkEnrichmentComplete callback", () => {
  let mockQdrant: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
  });

  it("fires callback with collectionName after all providers complete chunk enrichment", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const provider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { commitCount: 5 }]])]])),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);
    coordinator.onChunkEnrichmentComplete = callback;
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 50));
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("test-col");
  });

  it("fires callback after ALL providers finish (not just the first)", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const callOrder: string[] = [];

    const slowProvider: any = {
      key: "slow",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockImplementation(
        async () =>
          new Promise((resolve) =>
            setTimeout(() => {
              callOrder.push("slow");
              resolve(new Map());
            }, 30),
          ),
      ),
    };
    const fastProvider: any = {
      key: "fast",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockImplementation(async () => {
        callOrder.push("fast");
        return Promise.resolve(new Map());
      }),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, [slowProvider, fastProvider]);
    coordinator.onChunkEnrichmentComplete = async () => {
      callOrder.push("callback");
      await callback();
    };
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 80));
    expect(callback).toHaveBeenCalledOnce();
    // Callback must fire AFTER both providers
    expect(callOrder.indexOf("callback")).toBeGreaterThan(callOrder.indexOf("slow"));
    expect(callOrder.indexOf("callback")).toBeGreaterThan(callOrder.indexOf("fast"));
  });

  it("does not fire callback when no providers exist", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const coordinator = new EnrichmentCoordinator(mockQdrant, []);
    coordinator.onChunkEnrichmentComplete = callback;

    coordinator.startChunkEnrichment("test-col", "/repo", new Map());
    await new Promise((r) => setTimeout(r, 30));
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not fire callback when all providers fail", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const provider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockRejectedValue(new Error("chunk fail")),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);
    coordinator.onChunkEnrichmentComplete = callback;
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 50));
    expect(callback).not.toHaveBeenCalled();
  });

  it("fires callback even when some providers fail and others succeed", async () => {
    const callback = vi.fn().mockResolvedValue(undefined);
    const goodProvider: any = {
      key: "good",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { x: 1 }]])]])),
    };
    const badProvider: any = {
      key: "bad",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockRejectedValue(new Error("fail")),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, [goodProvider, badProvider]);
    coordinator.onChunkEnrichmentComplete = callback;
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 50));
    // At least one succeeded → callback should fire
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith("test-col");
  });

  it("does not crash if callback throws", async () => {
    const provider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { x: 1 }]])]])),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);
    coordinator.onChunkEnrichmentComplete = vi.fn().mockRejectedValue(new Error("callback crash"));
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);

    // Should not throw
    expect(() => {
      coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("EnrichmentCoordinator — fire-and-forget marker error paths", () => {
  it("silently swallows setPayload error in initial prefetch marker write", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockRejectedValue(new Error("qdrant down")),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    // Should not throw even when initial marker write fails
    expect(() => {
      coordinator.prefetch("/repo", "test-col");
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    // setPayload was attempted (and failed silently)
    expect(mockQdrant.setPayload).toHaveBeenCalled();
  });

  it("silently swallows setPayload error in prefetch failure marker write", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockRejectedValue(new Error("qdrant down")),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockRejectedValue(new Error("git fail")),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 30));
    // Both initial and failure marker writes attempted — both fail silently
    expect(mockQdrant.setPayload).toHaveBeenCalled();
  });

  it("silently swallows setPayload error in chunk enrichment failure marker write", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockRejectedValue(new Error("qdrant down")),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockRejectedValue(new Error("chunk fail")),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 10));

    coordinator.startChunkEnrichment(
      "test-col",
      "/repo",
      new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]),
    );
    await new Promise((r) => setTimeout(r, 30));
    // Should not throw, setPayload was attempted
    expect(mockQdrant.setPayload).toHaveBeenCalled();
  });
});

describe("EnrichmentCoordinator — scoped prefetch (incremental reindex)", () => {
  it("skips matchedFiles/missedFiles in awaitCompletion marker when changedPaths provided", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    // Pass changedPaths to trigger scopedPrefetch=true
    coordinator.prefetch("/repo", "test-col", undefined, ["src/a.ts"]);
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // Find the final file marker written by awaitCompletion
    const { calls } = mockQdrant.setPayload.mock;
    const lastCall = calls[calls.length - 1];
    const marker = lastCall[1].enrichment;

    // With scoped prefetch, matchedFiles/missedFiles should NOT be set
    expect(marker.git.file.matchedFiles).toBeUndefined();
    expect(marker.git.file.missedFiles).toBeUndefined();
    // But status and timing should still be present
    expect(marker.git.file.status).toBe("completed");
    expect(marker.git.file.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("includes matchedFiles/missedFiles in awaitCompletion marker for full index (no changedPaths)", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    // No changedPaths → scopedPrefetch=false → should include coverage stats
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    const { calls } = mockQdrant.setPayload.mock;
    const lastCall = calls[calls.length - 1];
    const marker = lastCall[1].enrichment;

    // Full index: matchedFiles and missedFiles MUST be present
    expect(marker.git.file.matchedFiles).toBeDefined();
    expect(marker.git.file.missedFiles).toBeDefined();
  });
});

describe("EnrichmentCoordinator — backfill with fileSignalTransform", () => {
  it("applies fileSignalTransform during backfill when provider has one", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };

    const transform = vi.fn((data: Record<string, unknown>, maxEndLine: number) => ({
      transformed: true,
      maxEndLine,
      ...data,
    }));

    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map()) // prefetch: all missed
        .mockResolvedValueOnce(new Map([["src/foo.ts", { rawData: 1 }]])), // backfill
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
      fileSignalTransform: transform,
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/foo.ts" }, endLine: 25 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // fileSignalTransform should have been called during backfill
    expect(transform).toHaveBeenCalledWith({ rawData: 1 }, 25);

    // The backfill batchSetPayload call should contain the transformed data
    const backfillCalls = mockQdrant.batchSetPayload.mock.calls.filter((call: any[]) =>
      call[1]?.some?.((op: any) => op?.payload?.git?.file?.transformed === true),
    );
    expect(backfillCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("EnrichmentCoordinator — awaitCompletion metrics", () => {
  it("returns aggregated metrics across multiple providers", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
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
      getPoint: vi.fn().mockResolvedValue(null),
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

describe("EnrichmentCoordinator — per-level enrichment marker", () => {
  let mockQdrant: any;
  let mockProvider: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    mockProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
  });

  it("writes initial marker with file: in_progress and chunk: pending on prefetch start", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    // First setPayload call is the initial marker
    await new Promise((r) => setTimeout(r, 10));
    const initialCall = mockQdrant.setPayload.mock.calls[0];
    expect(initialCall).toBeDefined();

    const marker = initialCall[1].enrichment;
    expect(marker.git).toBeDefined();
    expect(marker.git.runId).toMatch(/^[a-f0-9]{8}$/);
    expect(marker.git.file.status).toBe("in_progress");
    expect(marker.git.file.startedAt).toBeDefined();
    expect(marker.git.file.unenrichedChunks).toBe(0);
    expect(marker.git.chunk.status).toBe("pending");
    expect(marker.git.chunk.unenrichedChunks).toBe(0);
  });

  it("writes file: completed with timing on successful awaitCompletion", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // Find the awaitCompletion marker write (last setPayload call)
    const { calls } = mockQdrant.setPayload.mock;
    const lastCall = calls[calls.length - 1];
    const marker = lastCall[1].enrichment;

    expect(marker.git.file.status).toBe("completed");
    expect(marker.git.file.completedAt).toBeDefined();
    expect(marker.git.file.durationMs).toBeGreaterThanOrEqual(0);
    expect(marker.git.file.unenrichedChunks).toBe(0);
  });

  it("writes file: failed and chunk: failed when prefetch fails", async () => {
    mockProvider.buildFileSignals.mockRejectedValue(new Error("git fail"));
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    await new Promise((r) => setTimeout(r, 20));

    // Find the failure marker write (after initial marker)
    const { calls } = mockQdrant.setPayload.mock;
    // Should have at least 2 calls: initial marker + failure marker
    expect(calls.length).toBeGreaterThanOrEqual(2);

    const failureCall = calls[1];
    const marker = failureCall[1].enrichment;

    expect(marker.git.file.status).toBe("failed");
    expect(marker.git.file.completedAt).toBeDefined();
    expect(marker.git.file.durationMs).toBeGreaterThanOrEqual(0);
    expect(marker.git.chunk.status).toBe("failed");
  });

  it("passes enrichedAt to applier.applyFileSignals calls", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    // Verify batchSetPayload was called (file signals were applied)
    expect(mockQdrant.batchSetPayload).toHaveBeenCalled();

    // The applier writes enrichedAt as part of the payload with key="git.file"
    const batchCall = mockQdrant.batchSetPayload.mock.calls[0];
    const operations = batchCall[1];
    expect(operations.length).toBeGreaterThan(0);
    const op = operations[0];
    expect(op.key).toBe("git.file");
    expect(op.payload.enrichedAt).toBeDefined();
  });

  it("writes chunk: completed marker after successful chunk enrichment", async () => {
    // buildChunkSignals must return Map<string, Map<string, ChunkSignalOverlay>>
    const chunkOverlays = new Map([["src/a.ts", new Map([["c1", { commitCount: 5 }]])]]);
    mockProvider.buildChunkSignals.mockResolvedValue(chunkOverlays);
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 50));

    // Find the chunk completion marker
    const { calls } = mockQdrant.setPayload.mock;
    const chunkMarkerCall = calls.find((call: any[]) => {
      const enrichment = call[1]?.enrichment;
      return enrichment?.git?.chunk?.status === "completed";
    });
    expect(chunkMarkerCall).toBeDefined();
    const marker = chunkMarkerCall[1].enrichment;
    expect(marker.git.chunk.completedAt).toBeDefined();
    expect(marker.git.chunk.durationMs).toBeGreaterThanOrEqual(0);
    expect(marker.git.chunk.unenrichedChunks).toBe(0);
  });

  it("writes chunk: failed marker when chunk enrichment fails", async () => {
    mockProvider.buildChunkSignals.mockRejectedValue(new Error("chunk fail"));
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    const chunkMap = new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", chunkMap);

    await new Promise((r) => setTimeout(r, 50));

    // Find the chunk failure marker
    const { calls } = mockQdrant.setPayload.mock;
    const chunkFailCall = calls.find((call: any[]) => {
      const enrichment = call[1]?.enrichment;
      return enrichment?.git?.chunk?.status === "failed";
    });
    expect(chunkFailCall).toBeDefined();
    const marker = chunkFailCall[1].enrichment;
    expect(marker.git.chunk.completedAt).toBeDefined();
    expect(marker.git.chunk.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("EnrichmentCoordinator — recovery integration", () => {
  let mockQdrant: any;
  let mockProvider: any;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    mockProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
  });

  it("should call runRecovery which delegates to EnrichmentRecovery", async () => {
    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);

    await coordWithRecovery.runRecovery("col", "/root");

    expect(mockRecovery.recoverFileLevel).toHaveBeenCalledWith("col", "/root", mockProvider, expect.any(String));
    expect(mockRecovery.recoverChunkLevel).toHaveBeenCalledWith("col", "/root", mockProvider, expect.any(String));
  });

  it("should skip recovery when marker shows unenrichedChunks=0 for all levels", async () => {
    // Marker says everything is enriched
    mockQdrant.getPoint.mockResolvedValue({
      payload: {
        enrichment: {
          git: {
            file: { status: "completed", unenrichedChunks: 0 },
            chunk: { status: "completed", unenrichedChunks: 0 },
          },
        },
      },
    });

    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);
    await coordWithRecovery.runRecovery("col", "/root");

    // Recovery should NOT have been called — marker guard skipped it
    expect(mockRecovery.recoverFileLevel).not.toHaveBeenCalled();
    expect(mockRecovery.recoverChunkLevel).not.toHaveBeenCalled();
  });

  it("should run recovery when marker shows unenrichedChunks > 0", async () => {
    mockQdrant.getPoint.mockResolvedValue({
      payload: {
        enrichment: {
          git: {
            file: { status: "completed", unenrichedChunks: 0 },
            chunk: { status: "degraded", unenrichedChunks: 42 },
          },
        },
      },
    });

    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);
    await coordWithRecovery.runRecovery("col", "/root");

    // Recovery SHOULD run — chunk level has unenriched
    expect(mockRecovery.recoverFileLevel).toHaveBeenCalled();
    expect(mockRecovery.recoverChunkLevel).toHaveBeenCalled();
  });

  it("should run recovery when marker says 0 but actual count > 0 (stale marker)", async () => {
    // Marker lies — says 0
    mockQdrant.getPoint.mockResolvedValue({
      payload: {
        enrichment: {
          git: {
            file: { status: "completed", unenrichedChunks: 0 },
            chunk: { status: "completed", unenrichedChunks: 0 },
          },
        },
      },
    });

    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 5, recoveredChunks: 100, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 5, recoveredChunks: 50, remainingUnenriched: 0 }),
      // Verify call returns actual non-zero count — stale marker detected
      countUnenriched: vi.fn().mockResolvedValue(8745),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);
    await coordWithRecovery.runRecovery("col", "/root");

    // Recovery SHOULD run despite marker showing 0 — verify detected stale marker
    expect(mockRecovery.recoverFileLevel).toHaveBeenCalled();
    expect(mockRecovery.recoverChunkLevel).toHaveBeenCalled();
  });

  it("should run recovery when marker is missing (first run)", async () => {
    mockQdrant.getPoint.mockResolvedValue(null);

    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);
    await coordWithRecovery.runRecovery("col", "/root");

    expect(mockRecovery.recoverFileLevel).toHaveBeenCalled();
    expect(mockRecovery.recoverChunkLevel).toHaveBeenCalled();
  });

  it("should use remainingUnenriched from recovery result instead of separate countUnenriched call", async () => {
    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 1, recoveredChunks: 3, remainingUnenriched: 5 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 1, recoveredChunks: 2, remainingUnenriched: 10 }),
      countUnenriched: vi.fn().mockResolvedValue(999),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);
    await coordWithRecovery.runRecovery("col", "/root");

    // countUnenriched should NOT be called — use remainingUnenriched from recover results
    expect(mockRecovery.countUnenriched).not.toHaveBeenCalled();

    // Marker should use remainingUnenriched values, not countUnenriched
    const markerCalls = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git !== undefined,
    );
    const lastMarker = markerCalls[markerCalls.length - 1][1].enrichment.git;
    expect(lastMarker.file.unenrichedChunks).toBe(5);
    expect(lastMarker.chunk.unenrichedChunks).toBe(10);
  });

  it("should be no-op when recovery not provided", async () => {
    const coordWithoutRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider);
    await coordWithoutRecovery.runRecovery("col", "/root");
    // Should not throw, should not call any qdrant methods for recovery
  });

  it("should update enrichment marker with post-recovery status from remainingUnenriched", async () => {
    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 2, recoveredChunks: 5, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 2, recoveredChunks: 5, remainingUnenriched: 0 }),
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);

    await coordWithRecovery.runRecovery("col", "/root");

    // Should have written enrichment marker with completed status
    const markerCalls = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git !== undefined,
    );
    expect(markerCalls.length).toBeGreaterThanOrEqual(1);
    const lastMarker = markerCalls[markerCalls.length - 1][1].enrichment.git;
    expect(lastMarker.file.status).toBe("completed");
    expect(lastMarker.chunk.status).toBe("completed");
    expect(lastMarker.file.unenrichedChunks).toBe(0);
  });

  it("should set degraded status when chunk-level remainingUnenriched > 0", async () => {
    const mockRecovery = {
      recoverFileLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 }),
      recoverChunkLevel: vi.fn().mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 3 }),
      countUnenriched: vi.fn().mockResolvedValue(999), // should not be called
    };

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, mockRecovery as any);

    await coordWithRecovery.runRecovery("col", "/root");

    const markerCalls = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git !== undefined,
    );
    const lastMarker = markerCalls[markerCalls.length - 1][1].enrichment.git;
    expect(lastMarker.file.status).toBe("completed");
    expect(lastMarker.chunk.status).toBe("degraded");
    expect(lastMarker.chunk.unenrichedChunks).toBe(3);
  });
});
