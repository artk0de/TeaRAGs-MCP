import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { CompletionRunner } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/completion-runner.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
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
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
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
    await marker.markRunStart("coll", ["git"], "run-1", "ts");

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
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
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
    await marker.markRunStart("coll", ["git"], "run-2", "ts");

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
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
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
    await marker.markRunStart("coll", ["git"], "run-3", "ts");

    // Stream a batch for a path that streamFileBatch/buildFileSignals returns no
    // overlay for — populates _missedFileChunks so step 3 (backfill) runs and
    // sets backfillOccurred=true.
    filePhase.onBatch("coll", "/repo", [
      { chunkId: "c-missed", chunk: { metadata: { filePath: "/repo/missed.ts" }, startLine: 1, endLine: 5 } } as any,
    ]);
    await filePhase.drain();

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
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
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
    await marker.markRunStart("coll", ["git"], "run-4", "ts");

    // No onBatch call — _missedFileChunks stays empty, backfill skipped.
    const cb = vi.fn().mockResolvedValue(undefined);
    chunkPhase.setOnComplete(cb);

    await runner.run("coll", contexts, Date.now());

    // No backfill → no second fire. Callback may have been invoked by streaming
    // (runner.run drains chunkPhase but no chunkWork was queued either), so
    // strict assertion: the post-backfill fire MUST NOT have fired.
    expect(cb).not.toHaveBeenCalled();
  });

  it("finalize file pass applies finalizeSignals overlays via applyFinalize", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
    });

    const finalizeSignals = vi.fn().mockResolvedValue(new Map([["a.ts", { fanIn: 2 }]]));
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map([["a.ts", new Map([["c1", { fanIn: 1 }]])]]));
    const ctx = {
      key: "codegraph.symbols",
      provider: {
        key: "codegraph.symbols",
        defersChunkEnrichment: true,
        finalizeSignals,
        buildChunkSignals,
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        streamFileBatch: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);

    filePhase.init(contexts, "coll", "run-fin", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    await marker.markRunStart("coll", ["codegraph.symbols"], "run-fin", "ts");

    // Accumulate a deferred chunkMap (deferred provider — onBatch only accumulates).
    chunkPhase.onBatch("coll", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/a.ts" }, startLine: 1, endLine: 10 } } as any,
    ]);

    await runner.run("coll", contexts, Date.now());

    expect(finalizeSignals).toHaveBeenCalledWith("/repo", expect.objectContaining({ collectionName: "coll" }));
    // file overlay applied via applyFinalizeFile (key codegraph.symbols.file)
    const ops = qdrant.batchSetPayloadCalls.flatMap((c) => c.operations);
    expect(ops.some((op: any) => op.key === "codegraph.symbols.file" && op.payload.fanIn === 2)).toBe(true);
    // deferred chunk pass ran
    expect(buildChunkSignals).toHaveBeenCalled();
    expect(ops.some((op: any) => op.key === "codegraph.symbols.chunk")).toBe(true);
  });

  it("runs the deferred chunk pass for a defersChunkEnrichment provider", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
    });

    const buildChunkSignals = vi.fn().mockResolvedValue(new Map([["a.ts", new Map([["c1", { fanIn: 3 }]])]]));
    const ctx = {
      key: "codegraph.symbols",
      provider: {
        key: "codegraph.symbols",
        defersChunkEnrichment: true,
        finalizeSignals: vi.fn().mockResolvedValue(new Map()),
        buildChunkSignals,
        buildFileSignals: vi.fn().mockResolvedValue(new Map()),
        streamFileBatch: vi.fn().mockResolvedValue(new Map()),
        resolveRoot: (p: string) => p,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null,
    };
    const contexts = new Map([[ctx.key, ctx]]);

    filePhase.init(contexts, "coll", "run-def", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    await marker.markRunStart("coll", ["codegraph.symbols"], "run-def", "ts");

    chunkPhase.onBatch("coll", "/repo", [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/a.ts" }, startLine: 1, endLine: 10 } } as any,
    ]);

    await runner.run("coll", contexts, Date.now());

    expect(buildChunkSignals).toHaveBeenCalledWith(
      "/repo",
      expect.any(Map),
      expect.objectContaining({ skipCache: true, collectionName: "coll" }),
    );
    // Dotted provider key is stored NESTED (enrichment.codegraph.symbols.chunk),
    // not as a literal "codegraph.symbols" property.
    const final = ((await marker.read("coll"))!.codegraph as any).symbols;
    expect(final.chunk.status).toBe("completed");
  });

  it("marks file degraded when file-level unenriched remain after finalize", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");

    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const filePhase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const backfiller = new EnrichmentBackfiller(applier, qdrant as any, new InlineEnrichmentExecutor());
    const runner = new CompletionRunner({
      filePhase,
      chunkPhase,
      backfiller,
      applier,
      markerStore: marker,
      executor: new InlineEnrichmentExecutor(),
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

    filePhase.init(contexts, "coll", "run-deg", "ts");
    chunkPhase.init(contexts, "coll", "ts");
    await marker.markRunStart("coll", ["git"], "run-deg", "ts");

    const reader = vi.fn(async (_c: string, _k: string, level: "file" | "chunk") => (level === "file" ? 2 : 0));
    await runner.run("coll", contexts, Date.now(), reader);

    const final = (await marker.read("coll"))!.git as any;
    expect(final.file.status).toBe("degraded");
    expect(final.file.unenrichedChunks).toBe(2);
  });
});
