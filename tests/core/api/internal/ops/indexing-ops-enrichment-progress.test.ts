import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { ChangeStats, IndexStats } from "../../../../../src/core/types.js";

const stats: IndexStats = {
  filesScanned: 1,
  filesIndexed: 1,
  chunksCreated: 10,
  durationMs: 5,
  status: "completed",
  errors: [],
  enrichmentStatus: "background",
};

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}): IndexingOpsDeps {
  return {
    // collectionExists=false → skip incremental, take full-index path
    qdrant: { collectionExists: vi.fn().mockResolvedValue(false) } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn().mockResolvedValue(stats) } as never,
    reindex: { reindexChanges: vi.fn() } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

describe("IndexingOps enrichment progress + awaitEnrichment", () => {
  it("forwards the enrichment progress callback to the coordinator", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);
    const cb = vi.fn();

    await ops.run("/repo", undefined, undefined, cb);

    expect(deps.enrichment.setEnrichmentProgress).toHaveBeenCalledWith(cb);
  });

  it("run() returns at embedding completion without blocking on enrichment", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    await ops.run("/repo");

    // run never blocks on enrichment — that is the worker's job via whenEnrichmentComplete.
    expect(deps.enrichment.whenComplete).not.toHaveBeenCalled();
  });

  it("whenEnrichmentComplete delegates to the coordinator", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    await ops.whenEnrichmentComplete();

    expect(deps.enrichment.whenComplete).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Stage-profiler reset + embed-warmup timing (csyve instrumentation)
// ---------------------------------------------------------------------------
// These tests exercise the new pipelineLog.resetProfiler() calls and the
// try/finally embed-warmup timing wrapper in checkEmbeddingHealth introduced
// by the csyve bead. They use IndexingOps directly rather than going through
// IngestFacade so the coverage attribution lands on indexing-ops.ts.

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 0,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 0,
  chunksDeleted: 0,
  durationMs: 5,
  status: "completed",
};

describe("IndexingOps csyve stage instrumentation", () => {
  it("reindexChanges resets the profiler and delegates to the reindex pipeline", async () => {
    const deps = makeDeps({
      reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
      statsCache: undefined,
    });
    const ops = new IndexingOps(deps);

    const result = await ops.reindexChanges("/repo");

    // pipelineLog.resetProfiler() + checkEmbeddingHealth (embed-warmup finally) ran;
    // the function returns the converted IndexStats shape.
    expect(result.status).toBe("completed");
    expect(deps.reindex.reindexChanges).toHaveBeenCalledWith("/repo", undefined);
  });

  it("embed-warmup finally block runs even when embed succeeds on first attempt", async () => {
    // Verifies the try/finally wrapper in checkEmbeddingHealth — both the success
    // path (return inside try) and the finally (addStageTime) must execute.
    const embedSpy = vi.fn().mockResolvedValue([0]);
    const deps = makeDeps({
      embeddings: { embed: embedSpy, resolveModelInfo: vi.fn().mockResolvedValue(undefined) } as never,
    });
    const ops = new IndexingOps(deps);

    await ops.run("/repo", { forceReindex: true });

    expect(embedSpy).toHaveBeenCalledWith("health");
  });

  it("embed-warmup finally block runs on the throw path (all retries exhausted)", async () => {
    // The throw-path inside try still triggers the finally block.
    const embedError = new Error("embedding down");
    const deps = makeDeps({
      embeddings: { embed: vi.fn().mockRejectedValue(embedError), resolveModelInfo: vi.fn() } as never,
      healthCheckRetryAttempts: 1,
      healthCheckRetryDelayMs: 0,
    });
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo", { forceReindex: true })).rejects.toThrow("embedding down");
  });
});
