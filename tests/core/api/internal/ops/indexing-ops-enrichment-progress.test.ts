import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { IndexStats } from "../../../../../src/core/types.js";

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
