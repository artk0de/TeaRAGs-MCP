/**
 * IndexingOps — an incremental run's partial outcome reaches the caller
 * (bd tea-rags-mcp-6l1w6).
 *
 * The reindex pipeline downgrades `ChangeStats.status` to "partial" when a
 * delete failed and counts the affected files. `toIndexStats` used to hardcode
 * "completed" and drop both counters, so `index_codebase` reported a clean run
 * while stale chunks stayed in the index.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const baseStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 2,
  filesDeleted: 1,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 3,
  chunksDeleted: 2,
  durationMs: 5,
  status: "completed",
};

function makeDeps(changeStats: ChangeStats): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      getPoint: vi.fn().mockResolvedValue(null),
      getPointOrThrow: vi.fn().mockResolvedValue(null),
      setPayload: vi.fn().mockResolvedValue(undefined),
    } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue({ model: "m", contextLength: 2048, dimensions: 768 }),
    } as never,
    config: { chunkSize: 2500, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      whenCompletionsSettled: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
  };
}

describe("IndexingOps — incremental partial outcome", () => {
  it("passes a partial status and both delete-failure counters through", async () => {
    const stats = await new IndexingOps(
      makeDeps({ ...baseStats, status: "partial", filesSkippedDueToDeleteFailure: 1, filesFailedToDelete: 1 }),
    ).run("/repo");

    expect(stats.status).toBe("partial");
    expect(stats.changeDetails?.filesSkippedDueToDeleteFailure).toBe(1);
    expect(stats.changeDetails?.filesFailedToDelete).toBe(1);
  });

  it("keeps a clean run completed, with no failure counters", async () => {
    const stats = await new IndexingOps(makeDeps(baseStats)).run("/repo");

    expect(stats.status).toBe("completed");
    expect(stats.changeDetails?.filesSkippedDueToDeleteFailure).toBeUndefined();
    expect(stats.changeDetails?.filesFailedToDelete).toBeUndefined();
  });

  it("passes the partial status through the --force-enrichments sync leg too", async () => {
    const stats = await new IndexingOps(makeDeps({ ...baseStats, status: "partial", filesFailedToDelete: 2 })).run(
      "/repo",
      { forceEnrichments: ["git"] },
    );

    expect(stats.status).toBe("partial");
    expect(stats.changeDetails?.filesFailedToDelete).toBe(2);
  });
});
