import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

// Real Qdrant set_payload requires the point to exist; mirror production seed
// (storeIndexingMarker) so EnrichmentMarkerStore writes are visible to read().
async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

describe("CompletionRunner", () => {
  it("runs the 7-step sequence and writes both file and chunk markers", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker);
    const chunkPhase = new ChunkPhase(applier);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
    });

    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);
    filePhase.init(contexts, "coll", "run-1", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    filePhase.startPrefetch();
    await marker.markStart("coll", ["git"], "run-1", "ts");

    const m = await runner.run("coll", contexts, Date.now() - 1000);
    expect(m.totalDurationMs).toBeGreaterThanOrEqual(0);

    const final = (await marker.read("coll"))!.git as any;
    expect(final.file.status).toBe("completed");
    expect(final.chunk.status).toBe("completed");
  });

  it("uses unenrichedReader callback for unenrichedChunks counts when provided", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker);
    const chunkPhase = new ChunkPhase(applier);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
    });

    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);
    filePhase.init(contexts, "coll", "run-2", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    filePhase.startPrefetch();
    await marker.markStart("coll", ["git"], "run-2", "ts");

    const reader = vi.fn(async (_coll: string, _key: string, level: "file" | "chunk") => (level === "file" ? 3 : 17));

    await runner.run("coll", contexts, Date.now() - 100, reader);

    const final = (await marker.read("coll"))!.git as any;
    expect(final.file.unenrichedChunks).toBe(3);
    // chunk count > 0 → degraded
    expect(final.chunk.status).toBe("degraded");
    expect(final.chunk.unenrichedChunks).toBe(17);
    expect(reader).toHaveBeenCalledWith("coll", "git", "file");
    expect(reader).toHaveBeenCalledWith("coll", "git", "chunk");
  });

  it("re-fires chunkPhase.onComplete after backfill produces overlays", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker);
    const chunkPhase = new ChunkPhase(applier);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
    });

    const ctx = {
      key: "git",
      provider: {
        key: "git",
        // Empty prefetch + backfill — applier.getMissedFileChunks() will be non-empty.
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);

    filePhase.init(contexts, "coll", "run-3", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    filePhase.startPrefetch();
    await marker.markStart("coll", ["git"], "run-3", "ts");

    // Push a chunk for a path that's not in fileMetadata — populates _missedFileChunks
    // so step 3 (backfill) runs and sets backfillOccurred=true.
    await new Promise((r) => setTimeout(r, 20));
    filePhase.onBatch("coll", "/repo", [
      { chunkId: "c-missed", chunk: { metadata: { filePath: "/repo/missed.ts" }, endLine: 5 } } as any,
    ]);
    await new Promise((r) => setTimeout(r, 20));

    const cb = vi.fn().mockResolvedValue(undefined);
    chunkPhase.setOnComplete(cb);

    await runner.run("coll", contexts, Date.now());

    // Backfill ran (missed > 0) → fireOnComplete invoked once with collectionName.
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("coll");
  });

  it("does NOT re-fire chunkPhase.onComplete when backfill is skipped", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker);
    const chunkPhase = new ChunkPhase(applier);
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any);
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
    });

    const ctx = {
      key: "git",
      provider: {
        key: "git",
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
        fileSignalTransform: undefined,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);

    filePhase.init(contexts, "coll", "run-4", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    filePhase.startPrefetch();
    await marker.markStart("coll", ["git"], "run-4", "ts");

    // No onBatch call — _missedFileChunks stays empty, backfill skipped.
    const cb = vi.fn().mockResolvedValue(undefined);
    chunkPhase.setOnComplete(cb);

    await runner.run("coll", contexts, Date.now());

    // No backfill → no second fire. Callback may have been invoked by streaming
    // (runner.run drains chunkPhase but no chunkWork was queued either), so
    // strict assertion: the post-backfill fire MUST NOT have fired.
    expect(cb).not.toHaveBeenCalled();
  });
});
