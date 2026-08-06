/**
 * IndexingOps — score background attached to the refreshed collection stats.
 *
 * Search confidence reads a result set as a z-score against the collection's
 * own similarity scale, so that scale has to be measured once per (re)index and
 * persisted alongside the signal stats.
 */

import { describe, expect, it, vi } from "vitest";

import { IndexingOps, type IndexingOpsDeps } from "../../../../../src/core/api/internal/ops/indexing-ops.js";
import type { CollectionSignalStats } from "../../../../../src/core/contracts/types/trajectory.js";

/** Deterministic fan of unit vectors — a real, non-degenerate similarity spread. */
function vectorPage(count: number) {
  return {
    points: Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI;
      return { id: `${i}`, vector: [Math.cos(angle), Math.sin(angle), 0] };
    }),
    next_page_offset: null,
  };
}

function makeDeps(scroll: ReturnType<typeof vi.fn>, save: ReturnType<typeof vi.fn>): IndexingOpsDeps {
  return {
    qdrant: {
      collectionExists: vi.fn().mockResolvedValue(true),
      aliases: { listAliases: vi.fn().mockResolvedValue([]) },
      client: { scroll },
    } as never,
    embeddings: { embed: vi.fn(), resolveModelInfo: vi.fn() } as never,
    config: { chunkSize: 1000, userSetChunkSize: false } as never,
    indexing: { indexCodebase: vi.fn() } as never,
    reindex: { reindexChanges: vi.fn() } as never,
    enrichment: {
      setEnrichmentProgress: vi.fn(),
      whenComplete: vi.fn(),
      runRecovery: vi.fn(),
    } as never,
    snapshotDir: "/tmp/snap",
    statsCache: { save, load: vi.fn().mockReturnValue(null) } as never,
    allPayloadSignals: [{ key: "language", type: "string", description: "lang" }] as never,
    statsAccumulators: [],
  };
}

describe("IndexingOps — collection score background", () => {
  it("measures the similarity scale and saves it with the stats", async () => {
    // Payload scroll (stats) then vector scroll (background) hit the same client.
    const scroll = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ payload: { language: "typescript" } }], next_page_offset: null })
      .mockResolvedValueOnce(vectorPage(400));
    const save = vi.fn();

    await new IndexingOps(makeDeps(scroll, save)).refreshStatsByCollection("code_test");

    const saved = save.mock.calls[0]?.[1] as CollectionSignalStats;
    expect(saved.scoreBackground).toBeDefined();
    expect(saved.scoreBackground!.sampleCount).toBeGreaterThan(0);
    expect(saved.scoreBackground!.stddev).toBeGreaterThan(0);
  });

  it("saves stats without a background when the collection is too small to describe one", async () => {
    const scroll = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ payload: { language: "typescript" } }], next_page_offset: null })
      .mockResolvedValueOnce(vectorPage(4));
    const save = vi.fn();

    await new IndexingOps(makeDeps(scroll, save)).refreshStatsByCollection("code_tiny");

    const saved = save.mock.calls[0]?.[1] as CollectionSignalStats;
    expect(save).toHaveBeenCalled();
    expect(saved.scoreBackground).toBeUndefined();
  });

  it("still saves the signal stats when the vector scroll fails", async () => {
    const scroll = vi
      .fn()
      .mockResolvedValueOnce({ points: [{ payload: { language: "typescript" } }], next_page_offset: null })
      .mockRejectedValueOnce(new Error("qdrant went away"));
    const save = vi.fn();

    await new IndexingOps(makeDeps(scroll, save)).refreshStatsByCollection("code_flaky");

    expect(save).toHaveBeenCalled();
    expect((save.mock.calls[0]?.[1] as CollectionSignalStats).scoreBackground).toBeUndefined();
  });
});
