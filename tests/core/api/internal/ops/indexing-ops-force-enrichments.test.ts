/**
 * IndexingOps — the `--force-enrichments` branch.
 *
 * The operation is "sync the working tree, THEN rebuild the enrichment layer".
 * The ordering is not a nicety: chunk point ids hash file content, so a
 * recompute run against a stale index writes signals onto ids that no longer
 * exist — a silent no-op in Qdrant, not an error.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

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

function makeDeps(overrides: Partial<IndexingOpsDeps> = {}): IndexingOpsDeps {
  return {
    qdrant: { collectionExists: vi.fn().mockResolvedValue(true) } as never,
    embeddings: {
      embed: vi.fn().mockResolvedValue([0]),
      resolveModelInfo: vi.fn().mockResolvedValue(undefined),
    } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: { reindexChanges: vi.fn().mockResolvedValue(changeStats) } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn().mockResolvedValue(undefined),
      runRecovery: vi.fn().mockResolvedValue(undefined),
      recomputeEnrichments: vi.fn().mockResolvedValue(undefined),
    } as never,
    snapshotDir: "/tmp/snap",
    ...overrides,
  };
}

describe("IndexingOps — forceEnrichments", () => {
  it("syncs the working tree before recomputing", async () => {
    const order: string[] = [];
    const deps = makeDeps({
      reindex: {
        reindexChanges: vi.fn(async () => {
          order.push("sync");
          return Promise.resolve(changeStats);
        }),
      } as never,
      enrichment: {
        setEnrichmentProgress: vi.fn(),
        whenComplete: vi.fn().mockResolvedValue(undefined),
        runRecovery: vi.fn().mockResolvedValue(undefined),
        recomputeEnrichments: vi.fn(async () => {
          order.push("recompute");
          return Promise.resolve();
        }),
      } as never,
    });
    const ops = new IndexingOps(deps);

    await ops.run("/repo", { forceEnrichments: ["git"] });

    expect(order).toEqual(["sync", "recompute"]);
  });

  it("passes the selectors through to the coordinator", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    await ops.run("/repo", { forceEnrichments: ["codegraph", "git"] });

    expect(deps.enrichment.recomputeEnrichments).toHaveBeenCalledWith(expect.any(String), expect.any(String), [
      "codegraph",
      "git",
    ]);
  });

  it("refuses to recompute when the codebase was never indexed", async () => {
    // Without this guard the sync would index the whole project from scratch,
    // paying for every embedding — the exact cost the flag exists to avoid.
    const deps = makeDeps({
      qdrant: { collectionExists: vi.fn().mockResolvedValue(false) } as never,
    });
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo", { forceEnrichments: ["git"] })).rejects.toThrow(/not indexed/i);
    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
  });

  it("never falls through to a full index", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    await ops.run("/repo", { forceEnrichments: ["git"] });

    expect(deps.indexing.indexCodebase).not.toHaveBeenCalled();
  });

  it("does not recompute when the sync fails", async () => {
    // Recomputing over a half-synced index produces signals that look valid
    // and are silently wrong, so a failed sync has to abort the whole run.
    const deps = makeDeps({
      reindex: { reindexChanges: vi.fn().mockRejectedValue(new Error("sync exploded")) } as never,
    });
    const ops = new IndexingOps(deps);

    await expect(ops.run("/repo", { forceEnrichments: ["git"] })).rejects.toThrow("sync exploded");
    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
  });

  it("leaves the ordinary incremental path untouched when the flag is absent", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    await ops.run("/repo");

    expect(deps.enrichment.recomputeEnrichments).not.toHaveBeenCalled();
    expect(deps.reindex.reindexChanges).toHaveBeenCalled();
  });

  it("reports the run as completed", async () => {
    const deps = makeDeps();
    const ops = new IndexingOps(deps);

    const result = await ops.run("/repo", { forceEnrichments: ["all"] });

    expect(result.status).toBe("completed");
  });
});
