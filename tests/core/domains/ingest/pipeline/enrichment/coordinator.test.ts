import ignore from "ignore";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EnrichmentProvider } from "../../../../../../src/core/contracts/types/provider.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { EnrichmentRecovery } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/recovery.js";

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
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith(
      "/repo",
      chunkMap,
      expect.objectContaining({ skipCache: true }),
    );
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
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledWith(
      "/repo",
      chunkMap,
      expect.objectContaining({ skipCache: true }),
    );
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

// Marker-write logic (deep-merge, error handling, per-provider state) is now
// owned by EnrichmentMarkerStore. See marker-store.test.ts for unit coverage.

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

  it("backfill triggers chunk-level enrichment for recovered files", async () => {
    // Regression: backfillMissedFiles previously wrote ONLY file-level signals,
    // leaving chunks of recovered files without chunk-level data. The chunk
    // marker then reported them as "degraded" with non-zero unenrichedChunks.
    // Expectation: backfill must also call provider.buildChunkSignals for the
    // recovered paths and apply the resulting chunk overlays.
    const chunkOverlay = new Map([["c-missed", { commitCount: 7, blameDominantAuthor: "Alice" }]]);
    mockProvider = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi
        .fn()
        .mockResolvedValueOnce(new Map()) // initial prefetch — all files missed
        .mockResolvedValueOnce(new Map([["src/missed.ts", { recovered: true }]])), // backfill file-level
      buildChunkSignals: vi
        .fn()
        // initial streaming chunk-enrichment call may receive empty map (no batches matched)
        .mockResolvedValueOnce(new Map())
        // backfill chunk-enrichment call for missed file
        .mockResolvedValueOnce(new Map([["src/missed.ts", chunkOverlay]])),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c-missed", chunk: { metadata: { filePath: "/repo/src/missed.ts" }, endLine: 25 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // buildChunkSignals must have been called with the missed path's chunk map.
    const chunkCalls = mockProvider.buildChunkSignals.mock.calls as any[];
    const backfillChunkCall = chunkCalls.find((call: any[]) => {
      const chunkMap = call[1] as Map<string, unknown[]>;
      return chunkMap?.has("src/missed.ts");
    });
    expect(backfillChunkCall).toBeDefined();

    // The recovered chunk overlay must be written via batchSetPayload — find
    // an op carrying the chunk-level enrichment we returned. Backfill writes
    // MUST use the `key: "git.chunk"` parameter so Qdrant scopes the set to
    // that sub-tree. Without `key`, a payload of `{git: {chunk: ...}}` would
    // replace the entire `git` key and clobber `git.file.enrichedAt` written
    // by the streaming applier (or file-backfill) earlier in the same run.
    const allOps = mockQdrant.batchSetPayload.mock.calls.flatMap((c: any[]) => c[1] as any[]);
    const chunkLevelOp = allOps.find((op: any) => {
      const p = op?.payload;
      return p && (p.commitCount === 7 || p.blameDominantAuthor === "Alice");
    });
    expect(chunkLevelOp).toBeDefined();
    expect(chunkLevelOp.key).toBe("git.chunk");
    // Payload must NOT carry the nested `git` wrapper — that would clobber siblings.
    expect(chunkLevelOp.payload.git).toBeUndefined();

    // File-level backfill must also use scoped `key: "git.file"` for the same
    // reason. Find the file-backfill op (the recovered file-data write).
    const fileLevelOp = allOps.find((op: any) => op?.key === "git.file");
    expect(fileLevelOp).toBeDefined();
    expect(fileLevelOp.payload.git).toBeUndefined();
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

    // Backfill should produce 150 operations → 2 batches (100 + 50).
    // Filter batchSetPayload calls to only backfill batches: writes use the
    // scoped key "git.file" (no nested `git` wrapper in payload) and carry
    // the synthetic `recovered: true` field returned by buildFileSignals.
    const backfillCalls = mockQdrant.batchSetPayload.mock.calls.filter((call: any[]) => {
      const ops = call[1];
      return ops.length > 0 && ops[0].key === "git.file" && ops[0].payload?.recovered === true;
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

describe("EnrichmentCoordinator — marker counters reflect current run", () => {
  it("writes matchedFiles/missedFiles in awaitCompletion marker for scoped reindex (changedPaths provided)", async () => {
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
    // Pass changedPaths — counters still reflect this run's files, never stale full-index state.
    coordinator.prefetch("/repo", "test-col", undefined, ["src/a.ts"]);
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    const { calls } = mockQdrant.setPayload.mock;
    const fileWrite = calls.find((call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed");
    expect(fileWrite).toBeDefined();
    const marker = fileWrite![1].enrichment;

    expect(marker.git.file.matchedFiles).toBeDefined();
    expect(marker.git.file.missedFiles).toBeDefined();
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
    const fileWrite = calls.find((call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed");
    expect(fileWrite).toBeDefined();
    const marker = fileWrite![1].enrichment;

    // Full index: matchedFiles and missedFiles MUST be present
    expect(marker.git.file.matchedFiles).toBeDefined();
    expect(marker.git.file.missedFiles).toBeDefined();
  });
});

describe("EnrichmentCoordinator — countSettledUnenriched re-poll", () => {
  it("re-polls countUnenriched once after grace period when first count is non-zero", async () => {
    // Regression: batchSetPayload writes use wait:false, so Qdrant's
    // payload-filter index can lag the actual point payloads. The first
    // countUnenriched after Promise.allSettled may report stale "unenriched"
    // chunks that have already been written but not yet indexed. The marker
    // must not lock in this transient stale value — re-poll after a grace
    // period and persist the settled count.
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

    // First poll returns 5 (stale), second returns 0 (filter index caught up)
    const recovery = {
      countUnenriched: vi
        .fn()
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(0),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // file level: first=5 (non-zero) → re-poll → 3 (2 calls)
    // chunk level: first=0 (zero) → short-circuit (1 call)
    // Total: 3 calls, with the helper writing the SETTLED (lower) value 3.
    expect(recovery.countUnenriched).toHaveBeenCalledTimes(3);

    // Marker must persist the settled (lower) value, not the stale first read.
    const { calls } = mockQdrant.setPayload.mock;
    const fileMarker = calls.find((call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed")?.[1]
      .enrichment.git.file;
    expect(fileMarker?.unenrichedChunks).toBe(3); // settled value, not stale 5
  });

  it("short-circuits when first count is zero (no grace period delay)", async () => {
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

    // Both file and chunk return 0 immediately → no re-poll needed
    const recovery = {
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // Each level (file + chunk) called exactly once — no re-poll because first === 0
    expect(recovery.countUnenriched).toHaveBeenCalledTimes(2);
  });
});

describe("EnrichmentCoordinator — file marker writes before chunk completion", () => {
  it("writes file: completed marker even when streaming chunk work is still in flight", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };

    let releaseChunk: () => void = () => {};
    const chunkBlocked = new Promise<Map<string, Map<string, Record<string, unknown>>>>((resolve) => {
      releaseChunk = () => {
        resolve(new Map([["src/a.ts", new Map([["c1", { commitCount: 5 }]])]]));
      };
    });

    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockReturnValue(chunkBlocked),
    };

    const recovery = {
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    const completionPromise = coordinator.awaitCompletion("test-col");
    // Yield enough cycles for awaitCompletion to drain file work + write file marker.
    // Chunk work is still blocked on chunkBlocked.
    await new Promise((r) => setTimeout(r, 50));

    const fileCompletedWrite = mockQdrant.setPayload.mock.calls.find(
      (call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed",
    );
    expect(fileCompletedWrite).toBeDefined();

    // Chunk completion must NOT be written yet — it is still pending.
    const chunkCompletedBeforeRelease = mockQdrant.setPayload.mock.calls.find(
      (call: any[]) => call[1]?.enrichment?.git?.chunk?.status === "completed",
    );
    expect(chunkCompletedBeforeRelease).toBeUndefined();

    releaseChunk();
    await completionPromise;
  });

  it("writes file marker first, then chunk marker, in awaitCompletion", async () => {
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };

    let releaseChunk: () => void = () => {};
    const chunkBlocked = new Promise<Map<string, Map<string, Record<string, unknown>>>>((resolve) => {
      releaseChunk = () => {
        resolve(new Map([["src/a.ts", new Map([["c1", { commitCount: 5 }]])]]));
      };
    });

    const mockProvider: any = {
      key: "git",
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]])),
      buildChunkSignals: vi.fn().mockReturnValue(chunkBlocked),
    };

    const recovery = {
      countUnenriched: vi.fn().mockResolvedValue(0),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, endLine: 10 } } as any,
    ]);

    const completionPromise = coordinator.awaitCompletion("test-col");
    await new Promise((r) => setTimeout(r, 30));
    releaseChunk();
    await completionPromise;

    const fileIdx = mockQdrant.setPayload.mock.calls.findIndex(
      (call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed",
    );
    const chunkIdx = mockQdrant.setPayload.mock.calls.findIndex(
      (call: any[]) => call[1]?.enrichment?.git?.chunk?.status === "completed",
    );

    expect(fileIdx).toBeGreaterThanOrEqual(0);
    expect(chunkIdx).toBeGreaterThanOrEqual(0);
    expect(fileIdx).toBeLessThan(chunkIdx);
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

    // The backfill batchSetPayload call should contain the transformed data.
    // Writes use the scoped key "git.file" so the payload is flat — no nested
    // `git` wrapper.
    const backfillCalls = mockQdrant.batchSetPayload.mock.calls.filter((call: any[]) =>
      call[1]?.some?.((op: any) => op?.key === "git.file" && op?.payload?.transformed === true),
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

    // Find the file: completed marker write (no longer the last call after split)
    const { calls } = mockQdrant.setPayload.mock;
    const fileCompletedCall = calls.find((call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed");
    expect(fileCompletedCall).toBeDefined();
    const marker = fileCompletedCall![1].enrichment;

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

    // Chunk marker status is finalized in awaitCompletion (post-split contract).
    await coordinator.awaitCompletion("test-col");

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

    // Chunk marker status is finalized in awaitCompletion (post-split contract).
    await coordinator.awaitCompletion("test-col");

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
    const recovery = new EnrichmentRecovery(mockQdrant, {} as any);
    const fileSpy = vi
      .spyOn(recovery, "recoverFileLevel")
      .mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 });
    const chunkSpy = vi
      .spyOn(recovery, "recoverChunkLevel")
      .mockResolvedValue({ recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 });

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery);

    await coordWithRecovery.runRecovery("col", "/root");

    expect(fileSpy).toHaveBeenCalledWith("col", "/root", mockProvider, expect.any(String));
    expect(chunkSpy).toHaveBeenCalledWith("col", "/root", mockProvider, expect.any(String));
  });

  it("should be no-op when recovery not provided", async () => {
    const coordWithoutRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider);
    await coordWithoutRecovery.runRecovery("col", "/root");
    // Should not throw, should not call any qdrant methods for recovery
  });

  it("should use remainingUnenriched from recovery result instead of separate countUnenriched call", async () => {
    const recovery = new EnrichmentRecovery(mockQdrant, {} as any);
    vi.spyOn(recovery, "recoverFileLevel").mockResolvedValue({
      recoveredFiles: 1,
      recoveredChunks: 3,
      remainingUnenriched: 5,
    });
    vi.spyOn(recovery, "recoverChunkLevel").mockResolvedValue({
      recoveredFiles: 1,
      recoveredChunks: 2,
      remainingUnenriched: 10,
    });
    const countSpy = vi.spyOn(recovery, "countUnenriched").mockResolvedValue(999);

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery);
    await coordWithRecovery.runRecovery("col", "/root");

    // countUnenriched should NOT be called — use remainingUnenriched from recover results
    expect(countSpy).not.toHaveBeenCalled();

    // Marker should use remainingUnenriched values, not countUnenriched
    const markerCalls = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git !== undefined,
    );
    const lastMarker = markerCalls[markerCalls.length - 1][1].enrichment.git;
    expect(lastMarker.file.unenrichedChunks).toBe(5);
    expect(lastMarker.chunk.unenrichedChunks).toBe(10);
  });

  it("should update enrichment marker with post-recovery status from remainingUnenriched", async () => {
    const recovery = new EnrichmentRecovery(mockQdrant, {} as any);
    vi.spyOn(recovery, "recoverFileLevel").mockResolvedValue({
      recoveredFiles: 2,
      recoveredChunks: 5,
      remainingUnenriched: 0,
    });
    vi.spyOn(recovery, "recoverChunkLevel").mockResolvedValue({
      recoveredFiles: 2,
      recoveredChunks: 5,
      remainingUnenriched: 0,
    });

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery);

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
    const recovery = new EnrichmentRecovery(mockQdrant, {} as any);
    vi.spyOn(recovery, "recoverFileLevel").mockResolvedValue({
      recoveredFiles: 0,
      recoveredChunks: 0,
      remainingUnenriched: 0,
    });
    vi.spyOn(recovery, "recoverChunkLevel").mockResolvedValue({
      recoveredFiles: 0,
      recoveredChunks: 0,
      remainingUnenriched: 3,
    });

    const coordWithRecovery = new EnrichmentCoordinator(mockQdrant, mockProvider, recovery);

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

describe("EnrichmentCoordinator — streaming chunk enrichment", () => {
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

  it("calls buildChunkSignals per batch after prefetch completes, with skipCache + semaphore", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 5 },
      } as any,
      {
        chunkId: "c2",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 6, endLine: 10 },
      } as any,
    ]);

    await new Promise((r) => setTimeout(r, 50));

    expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
    const call = mockProvider.buildChunkSignals.mock.calls[0];
    const [, batchMap, options] = call;
    expect(batchMap.has("src/a.ts")).toBe(true);
    expect(batchMap.get("src/a.ts").length).toBe(2);
    expect(options).toMatchObject({
      skipCache: true,
      concurrencySemaphore: expect.objectContaining({ acquire: expect.any(Function) }),
    });
  });

  it("queues chunk enrichment when prefetch is still pending, flushes on prefetch resolve", async () => {
    let resolvePrefetch: (v: Map<string, Record<string, unknown>>) => void;
    mockProvider.buildFileSignals.mockReturnValue(
      new Promise((resolve) => {
        resolvePrefetch = resolve;
      }),
    );

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 },
      } as any,
    ]);

    await new Promise((r) => setTimeout(r, 10));
    expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();

    resolvePrefetch!(new Map([["src/a.ts", { x: 1 }]]));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockProvider.buildChunkSignals).toHaveBeenCalled();
  });

  it("startChunkEnrichment skips files already enriched by streaming", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 },
      } as any,
    ]);
    await new Promise((r) => setTimeout(r, 50));

    mockProvider.buildChunkSignals.mockClear();

    const fullChunkMap = new Map([["/repo/src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]);
    coordinator.startChunkEnrichment("test-col", "/repo", fullChunkMap);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockProvider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("startChunkEnrichment processes files NOT covered by streaming", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 },
      } as any,
    ]);
    await new Promise((r) => setTimeout(r, 50));

    mockProvider.buildChunkSignals.mockClear();
    mockProvider.buildChunkSignals.mockResolvedValue(new Map());

    const fullChunkMap = new Map([
      ["/repo/src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
      ["/repo/src/b.ts", [{ chunkId: "c2", startLine: 1, endLine: 20 }]],
    ]);
    coordinator.startChunkEnrichment("test-col", "/repo", fullChunkMap);

    await new Promise((r) => setTimeout(r, 20));
    expect(mockProvider.buildChunkSignals).toHaveBeenCalledTimes(1);
    const calledMap = mockProvider.buildChunkSignals.mock.calls[0][1] as Map<string, unknown>;
    expect(calledMap.has("/repo/src/b.ts")).toBe(true);
    expect(calledMap.has("/repo/src/a.ts")).toBe(false);
  });

  it("awaitCompletion waits for in-flight streaming chunk work", async () => {
    let resolveChunkSignals: (v: Map<string, Map<string, unknown>>) => void;
    mockProvider.buildChunkSignals.mockReturnValue(
      new Promise((resolve) => {
        resolveChunkSignals = resolve;
      }),
    );

    const coordinator = new EnrichmentCoordinator(mockQdrant, mockProvider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    coordinator.onChunksStored("test-col", "/repo", [
      {
        chunkId: "c1",
        chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 },
      } as any,
    ]);

    let completed = false;
    const completionPromise = coordinator.awaitCompletion("test-col").then(() => {
      completed = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    expect(completed).toBe(false);

    resolveChunkSignals!(new Map());
    await completionPromise;
    expect(completed).toBe(true);
  });
});

describe("EnrichmentCoordinator — runRecovery stale-marker protection", () => {
  const mkProvider = (key = "git") => ({
    key,
    signals: [],
    filters: [],
    presets: [],
    resolveRoot: vi.fn((p: string) => p),
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  });

  const mkRecovery = (qdrant: any, file = 0, chunk = 0): EnrichmentRecovery => {
    const r = new EnrichmentRecovery(qdrant, {} as any);
    vi.spyOn(r, "recoverFileLevel").mockResolvedValue({
      recoveredFiles: 0,
      recoveredChunks: 0,
      remainingUnenriched: file,
    });
    vi.spyOn(r, "recoverChunkLevel").mockResolvedValue({
      recoveredFiles: 0,
      recoveredChunks: 0,
      remainingUnenriched: chunk,
    });
    return r;
  };

  const markerPoint = (enrichment: Record<string, unknown>) => ({
    id: "meta",
    payload: { enrichment },
  });

  it("skips marker writeback when runId changes between recovery start and end", async () => {
    const provider = mkProvider();
    // Before recovery: runId=A. After recovery finishes: runId=B (new pipeline run stamped it).
    const getPoint = vi
      .fn()
      .mockResolvedValueOnce(markerPoint({ git: { runId: "A" } })) // baseline snapshot
      .mockResolvedValueOnce(markerPoint({ git: { runId: "B" } })); // after recovery
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint,
    };
    const recovery = mkRecovery(mockQdrant, 0, 42); // would otherwise write chunk=degraded, unenriched=42

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider as any, recovery);
    await coordinator.runRecovery("test-col", "/repo");

    // Writeback with recovery verdict must NOT happen — fresher run owns the marker now.
    const degradedWrite = mockQdrant.setPayload.mock.calls.find(
      (call: any[]) => call[1]?.enrichment?.git?.chunk?.status === "degraded",
    );
    expect(degradedWrite).toBeUndefined();
  });

  it("writes recovery marker when runId is unchanged across recovery", async () => {
    const provider = mkProvider();
    const getPoint = vi
      .fn()
      .mockResolvedValueOnce(markerPoint({ git: { runId: "A" } }))
      .mockResolvedValueOnce(markerPoint({ git: { runId: "A" } }));
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint,
    };
    const recovery = mkRecovery(mockQdrant, 0, 7);

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider as any, recovery);
    await coordinator.runRecovery("test-col", "/repo");

    const degradedWrite = mockQdrant.setPayload.mock.calls.find(
      (call: any[]) => call[1]?.enrichment?.git?.chunk?.status === "degraded",
    );
    expect(degradedWrite).toBeDefined();
    expect(degradedWrite![1].enrichment.git.chunk.unenrichedChunks).toBe(7);
  });

  it("awaitCompletion writes final unenrichedChunks from recovery.countUnenriched (honest state)", async () => {
    const provider = mkProvider();
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const recovery = {
      recoverFileLevel: vi.fn(),
      recoverChunkLevel: vi.fn(),
      countUnenriched: vi
        .fn()
        .mockImplementation(async (_col: string, _key: string, level: "file" | "chunk") => (level === "file" ? 3 : 17)),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider as any, recovery as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    // Final file marker written in awaitCompletion — must reflect actual count.
    const fileWrites = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed",
    );
    const lastFileWrite = fileWrites[fileWrites.length - 1];
    expect(lastFileWrite[1].enrichment.git.file.unenrichedChunks).toBe(3);
    expect(recovery.countUnenriched).toHaveBeenCalledWith("test-col", "git", "file");
    expect(recovery.countUnenriched).toHaveBeenCalledWith("test-col", "git", "chunk");
  });

  it("awaitCompletion falls back to 0 unenrichedChunks when recovery is not provided", async () => {
    const provider = mkProvider();
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider as any);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    await coordinator.awaitCompletion("test-col");

    const fileWrites = mockQdrant.setPayload.mock.calls.filter(
      (call: any[]) => call[1]?.enrichment?.git?.file?.status === "completed",
    );
    const lastFileWrite = fileWrites[fileWrites.length - 1];
    expect(lastFileWrite[1].enrichment.git.file.unenrichedChunks).toBe(0);
  });

  it("writes recovery marker when no prior marker exists (first-ever run)", async () => {
    const provider = mkProvider();
    const mockQdrant: any = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      // both reads return null → baselineRunId === currentRunId === undefined → allowed
      getPoint: vi.fn().mockResolvedValue(null),
    };
    const recovery = mkRecovery(mockQdrant, 0, 0);

    const coordinator = new EnrichmentCoordinator(mockQdrant, provider as any, recovery);
    await coordinator.runRecovery("test-col", "/repo");

    const recoveryWrite = mockQdrant.setPayload.mock.calls.find(
      (call: any[]) => call[1]?.enrichment?.git?.chunk?.status === "completed",
    );
    expect(recoveryWrite).toBeDefined();
  });
});

describe("EnrichmentCoordinator — RunState isolation", () => {
  let mockQdrant: any;
  let provider: EnrichmentProvider;

  beforeEach(() => {
    mockQdrant = {
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      setPayload: vi.fn().mockResolvedValue(undefined),
      getPoint: vi.fn().mockResolvedValue(null),
    };
    provider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      // Empty file metadata on every prefetch — every applied chunk will be "missed".
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };
  });

  it("run 2's backfill does not include zombie missed paths from run 1", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);

    // Run 1 — chunk for "missed-1.ts" is applied; with empty fileMetadata it
    // becomes a missed path. Backfill runs against that single path.
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/missed-1.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await coordinator.awaitCompletion("test-col");

    // Run 2 — DIFFERENT path "missed-2.ts". With shared applier (current bug),
    // _missedFileChunks still holds "missed-1.ts" zombie, so run 2's backfill
    // will see paths=["missed-1.ts","missed-2.ts"]. With per-run RunState the
    // backfill must see paths=["missed-2.ts"] only.
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c2", chunk: { metadata: { filePath: "/repo/missed-2.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    await coordinator.awaitCompletion("test-col");

    // Inspect every buildFileSignals call that carries a `paths` argument
    // (those are backfill calls, not prefetch).
    const backfillCalls = (provider.buildFileSignals as any).mock.calls.filter(
      (call: any[]) => call[1]?.paths !== undefined,
    );
    expect(backfillCalls.length).toBe(2);

    // Run 2's backfill (last one) must contain ONLY "missed-2.ts".
    const lastBackfillPaths = backfillCalls[1][1].paths as string[];
    expect(lastBackfillPaths).toEqual(["missed-2.ts"]);
    expect(lastBackfillPaths).not.toContain("missed-1.ts");
  });

  it("re-binds onChunkEnrichmentComplete to current run when set after prefetch", async () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Set the callback AFTER prefetch — this hits the `if (cb && this.currentRun)`
    // branch that re-binds to the active RunState's chunkPhase.
    const cb = vi.fn().mockResolvedValue(undefined);
    coordinator.onChunkEnrichmentComplete = cb;

    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/x.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));
    coordinator.startChunkEnrichment("test-col", "/repo", new Map());
    await coordinator.awaitCompletion("test-col");
    await new Promise((r) => setTimeout(r, 20));

    // Callback was bound to current run's chunkPhase post-prefetch and fired on completion.
    expect(cb).toHaveBeenCalledWith("test-col");
  });

  it("rejects awaitCompletion donePromise when completion.run throws", async () => {
    // All awaited calls inside CompletionRunner.run wrap their own errors
    // (Promise.allSettled, internal try/catch, marker-store.write swallowing).
    // To exercise the catch block in awaitCompletion we stub the current run's
    // CompletionRunner directly — same boundary the catch protects.
    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);
    coordinator.prefetch("/repo", "test-col");
    await new Promise((r) => setTimeout(r, 20));
    coordinator.onChunksStored("test-col", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/x.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const runState = (coordinator as any).currentRun;
    expect(runState).not.toBeNull();
    const boom = new Error("completion exploded");
    vi.spyOn(runState.completion, "run").mockRejectedValue(boom);

    // The catch block re-throws after rejecting the donePromise.
    await expect(coordinator.awaitCompletion("test-col")).rejects.toThrow("completion exploded");

    // The donePromise on the orphaned RunState is also rejected (line 202).
    await expect(runState.donePromise).rejects.toThrow("completion exploded");
  });

  it("exposes the onChunkEnrichmentComplete callback via getter", () => {
    const coordinator = new EnrichmentCoordinator(mockQdrant, provider);

    // Unset by default — getter returns undefined.
    expect(coordinator.onChunkEnrichmentComplete).toBeUndefined();

    // Set the callback — getter returns the same function reference.
    const cb = vi.fn().mockResolvedValue(undefined);
    coordinator.onChunkEnrichmentComplete = cb;
    expect(coordinator.onChunkEnrichmentComplete).toBe(cb);
  });

  it("serializes concurrent prefetch calls FIFO behind the previous run's donePromise", async () => {
    const buildFileSignalsRoots: string[] = [];
    let resolveFirstBuild!: (value: Map<string, unknown>) => void;
    const firstBuildPromise = new Promise<Map<string, unknown>>((r) => {
      resolveFirstBuild = r;
    });

    const slowProvider: EnrichmentProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockImplementation(async (root: string) => {
        buildFileSignalsRoots.push(root);
        // First call resolves only when the test signals; later calls resolve immediately.
        return buildFileSignalsRoots.length === 1 ? firstBuildPromise : Promise.resolve(new Map());
      }),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, slowProvider);

    // Run 1 — prefetch is held open by the unresolved firstBuildPromise.
    coordinator.prefetch("/repo-1", "test-col");
    const completion1 = coordinator.awaitCompletion("test-col");

    // Run 2 — call prefetch while Run 1 is still pending.
    // FIFO contract: Run 2 must NOT call provider.buildFileSignals until Run 1 resolves.
    coordinator.prefetch("/repo-2", "test-col");

    // Pump several microtask cycles; Run 2's prefetch must still be queued.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(buildFileSignalsRoots).toEqual(["/repo-1"]);

    // Release Run 1.
    resolveFirstBuild(new Map());
    await completion1;
    await new Promise((r) => setTimeout(r, 20));

    // Now Run 2 must have started.
    expect(buildFileSignalsRoots).toEqual(["/repo-1", "/repo-2"]);
  });

  it("queues onChunksStored arriving between prefetch and serialized buildFileSignals start", async () => {
    // While Run 2's prefetch is still queued behind Run 1, callers may invoke
    // onChunksStored. The chunks must enqueue into Run 2's filePhase pendingBatches
    // (init runs synchronously) and drain once the deferred buildFileSignals resolves.
    const buildFileSignalsCalls: { root: string; opts?: unknown }[] = [];
    let resolveFirstBuild!: () => void;
    const firstBuildPromise = new Promise<Map<string, unknown>>((r) => {
      resolveFirstBuild = () => {
        r(new Map());
      };
    });

    const queuingProvider: EnrichmentProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockImplementation(async (root: string, opts?: unknown) => {
        buildFileSignalsCalls.push({ root, opts });
        return buildFileSignalsCalls.length === 1 ? firstBuildPromise : Promise.resolve(new Map());
      }),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, queuingProvider);

    // Run 1 — open.
    coordinator.prefetch("/repo-1", "test-col");
    const completion1 = coordinator.awaitCompletion("test-col");

    // Run 2 — prefetch deferred.
    coordinator.prefetch("/repo-2", "test-col");

    // Caller invokes onChunksStored on Run 2's collection BEFORE Run 1 finishes.
    // Init was synchronous in prefetch(); chunks must enqueue, not be silently dropped.
    coordinator.onChunksStored("test-col", "/repo-2", [
      { chunkId: "queued-c1", chunk: { metadata: { filePath: "/repo-2/queued.ts" }, endLine: 5 } } as any,
    ]);

    // Resolve Run 1 → Run 2's prefetch unblocks → buffered batch drains.
    resolveFirstBuild();
    await completion1;
    await new Promise((r) => setTimeout(r, 30));
    await coordinator.awaitCompletion("test-col");

    // Run 2's buildFileSignals must have been called exactly once with /repo-2 (no opts.paths
    // means it's the prefetch call, not a backfill).
    const run2Prefetch = buildFileSignalsCalls.find(
      (c) => c.root === "/repo-2" && (c.opts as { paths?: string[] } | undefined)?.paths === undefined,
    );
    expect(run2Prefetch).toBeDefined();
  });

  it("does not block run 2 when run 1's donePromise rejects", async () => {
    const buildFileSignalsRoots: string[] = [];
    const flakyProvider: EnrichmentProvider = {
      key: "git",
      signals: [],
      filters: [],
      presets: [],
      resolveRoot: vi.fn((p: string) => p),
      buildFileSignals: vi.fn().mockImplementation(async (root: string) => {
        buildFileSignalsRoots.push(root);
        return Promise.resolve(new Map());
      }),
      buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    };

    const coordinator = new EnrichmentCoordinator(mockQdrant, flakyProvider);

    // Run 1 — force completion to throw, which rejects donePromise.
    coordinator.prefetch("/repo-1", "test-col");
    const runState1 = (coordinator as { currentRun: { completion: { run: unknown } } | null }).currentRun;
    expect(runState1).not.toBeNull();
    vi.spyOn(runState1!.completion, "run" as never).mockRejectedValue(new Error("run 1 failed") as never);
    await expect(coordinator.awaitCompletion("test-col")).rejects.toThrow("run 1 failed");

    // Run 2 — must still start (the .catch(() => undefined) gate swallows run 1's rejection).
    coordinator.prefetch("/repo-2", "test-col");
    await new Promise((r) => setTimeout(r, 30));

    expect(buildFileSignalsRoots).toContain("/repo-2");
  });
});
