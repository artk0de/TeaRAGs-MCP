/**
 * IndexingOps — every path that syncs the working tree chunks with ONE size
 * (bd tea-rags-mcp-k8gac follow-up).
 *
 * The size is model-derived (`resolveEffectiveChunkSize`): the embedding
 * model's context window, minus a safety factor, unless the user pinned a
 * smaller one. The first index and the incremental run pass it to the pipeline;
 * the `--force-enrichments` sync leg and the deprecated explicit reindex did
 * not, so a file changed at recompute time was chunked at `config.chunkSize`
 * and its chunk boundaries — and point ids — disagreed with every other file.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { ChangeStats } from "../../../../../src/core/types.js";

const changeStats: ChangeStats = {
  filesAdded: 0,
  filesModified: 1,
  filesDeleted: 0,
  filesNewlyIgnored: 0,
  filesNewlyUnignored: 0,
  filesRetried: 0,
  chunksAdded: 3,
  chunksDeleted: 2,
  durationMs: 5,
  status: "completed",
};

const MODEL_INFO = { model: "nomic-embed-text", contextLength: 2048, dimensions: 768 };
/** 2048 tokens × 2 chars/token × 0.8 safety factor. */
const MODEL_DERIVED_CHUNK_SIZE = 3276;

function makeDeps(): IndexingOpsDeps {
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
      resolveModelInfo: vi.fn().mockResolvedValue(MODEL_INFO),
    } as never,
    // The configured default differs from the model-derived size — the whole bug.
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

/** The chunk-size override the pipeline received on its single sync call. */
function syncChunkSize(deps: IndexingOpsDeps): unknown {
  const { calls } = vi.mocked(deps.reindex.reindexChanges).mock;
  expect(calls).toHaveLength(1);
  return calls[0][2]?.chunkSize;
}

describe("IndexingOps — the sync leg chunks with the model-derived size", () => {
  it("an incremental run passes it (the reference every other sync must match)", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run("/repo");
    expect(syncChunkSize(deps)).toBe(MODEL_DERIVED_CHUNK_SIZE);
  });

  it("a --force-enrichments recompute chunks a changed file with the same size an incremental would", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).run("/repo", { forceEnrichments: ["git"] });
    expect(syncChunkSize(deps)).toBe(MODEL_DERIVED_CHUNK_SIZE);
  });

  it("the deprecated explicit reindex chunks with the same size too", async () => {
    const deps = makeDeps();
    await new IndexingOps(deps).reindexChanges("/repo");
    expect(syncChunkSize(deps)).toBe(MODEL_DERIVED_CHUNK_SIZE);
  });

  it("keeps a smaller size the user pinned, on the recompute as on an incremental", async () => {
    const deps = makeDeps();
    deps.config = { chunkSize: 1200, userSetChunkSize: true } as never;
    await new IndexingOps(deps).run("/repo", { forceEnrichments: ["codegraph"] });
    expect(syncChunkSize(deps)).toBe(1200);
  });
});
