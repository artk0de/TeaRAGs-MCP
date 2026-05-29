import ignore from "ignore";
import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { INDEXING_METADATA_ID } from "../../../../../../src/core/domains/ingest/constants.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { FilePhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/file-phase.js";
import { EnrichmentMarkerStore } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/marker-store.js";

// Real Qdrant set_payload requires the point to exist; mirror production seed
// (storeIndexingMarker) so EnrichmentMarkerStore writes are visible to read().
async function seedMarkerPoint(qdrant: MockQdrantManager, coll: string): Promise<void> {
  await qdrant.createCollection(coll, 384);
  await qdrant.addPoints(coll, [{ id: INDEXING_METADATA_ID, vector: new Array(384).fill(0), payload: {} }]);
}

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    key: "git",
    provider: {
      key: "git",
      buildFileSignals: vi.fn().mockResolvedValue(new Map()),
      buildChunkSignals: vi.fn(),
      resolveRoot: (p: string) => p,
      fileSignalTransform: undefined,
      ...overrides,
    } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null as any,
  };
}

const items = [
  {
    chunkId: "c1",
    chunk: {
      metadata: { filePath: "/repo/src/a.ts" },
      startLine: 1,
      endLine: 10,
    },
  } as any,
];

describe("FilePhase", () => {
  it("onBatch streams file signals per batch without a whole-repo prefetch", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    const streamFileBatch = vi.fn().mockResolvedValue(new Map([["src/a.ts", { commitCount: 3 }]]));
    const applySpy = vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const ctx = buildCtx({ streamFileBatch });

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");

    await phase.onBatch("coll", "/repo", items);
    await phase.drain();

    expect(streamFileBatch).toHaveBeenCalledWith("/repo", ["src/a.ts"], expect.anything());
    expect(applySpy).toHaveBeenCalled();
  });

  it("onBatch returns a Promise that resolves after the batch's file applies", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    let resolved = false;
    const streamFileBatch = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      resolved = true;
      return new Map([["src/a.ts", { x: 1 }]]);
    });
    vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const ctx = buildCtx({ streamFileBatch });

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");

    const p = phase.onBatch("coll", "/repo", items);
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(resolved).toBe(true);
  });

  it("falls back to buildFileSignals({ paths }) when streamFileBatch is absent", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    const buildFileSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", { x: 1 }]]));
    const applySpy = vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const ctx = buildCtx({ buildFileSignals });

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");

    await phase.onBatch("coll", "/repo", items);
    await phase.drain();

    expect(buildFileSignals).toHaveBeenCalledWith("/repo", expect.objectContaining({ paths: ["src/a.ts"] }));
    expect(applySpy).toHaveBeenCalled();
  });

  it("onBatch drives a defersChunkEnrichment provider's streamFileBatch (extraction) but does NOT apply or miss-track", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    // codegraph returns ∅ (overlays deferred) but the call MUST happen so the
    // run sink extracts the batch into the graph — finalize reads it back.
    const streamFileBatch = vi.fn().mockResolvedValue(new Map());
    const buildFileSignals = vi.fn().mockResolvedValue(new Map());
    const applySpy = vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const ctx = {
      key: "codegraph.symbols",
      provider: {
        key: "codegraph.symbols",
        defersChunkEnrichment: true,
        streamFileBatch,
        buildFileSignals,
        buildChunkSignals: vi.fn(),
        resolveRoot: (p: string) => p,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null as any,
    };

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    await phase.onBatch("coll", "/repo", items);
    await phase.drain();

    // Extraction is driven (sink fills the graph), but the ∅ result is NOT
    // applied and produces NO missed-file tracking (file overlays come from
    // finalizeSignals → applyFinalize, not from this per-batch call).
    expect(streamFileBatch).toHaveBeenCalledWith("/repo", ["src/a.ts"], expect.anything());
    expect(applySpy).not.toHaveBeenCalled();
    expect(applier.missedFiles).toBe(0);
  });

  it("applyFinalize applies file overlays keyed by the chunkMap", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    const ctx = {
      key: "codegraph.symbols",
      provider: { key: "codegraph.symbols", defersChunkEnrichment: true } as any,
      effectiveRoot: "/repo",
      ignoreFilter: null as any,
    };

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");

    const fileOverlays = new Map([["src/a.ts", { fanIn: 4 }]]);
    // chunkMap includes a file with NO overlay (e.g. markdown the provider
    // doesn't graph) — it must still receive a bare enrichedAt stamp so it is
    // not counted "unenriched" at the file level forever.
    const chunkMap = new Map([
      ["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]],
      ["docs/readme.md", [{ chunkId: "m1", startLine: 1, endLine: 3 }]],
    ]);
    await phase.applyFinalize("coll", ctx, fileOverlays, chunkMap);

    const ops = qdrant.batchSetPayloadCalls.flatMap((c) => c.operations);
    const matchedOp = ops.find((op: any) => op.key === "codegraph.symbols.file" && op.points[0] === "c1");
    expect(matchedOp.payload.fanIn).toBe(4);
    expect(matchedOp.payload.enrichedAt).toBe("ts");
    const stampOp = ops.find((op: any) => op.key === "codegraph.symbols.file" && op.points[0] === "m1");
    expect(stampOp).toBeDefined();
    expect(stampOp.payload.enrichedAt).toBe("ts");
    expect(stampOp.payload.fanIn).toBeUndefined();
    expect(applier.matchedFiles).toBe(1);
  });

  it("passes ctx.ignoreFilter through to streamFileBatch", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);

    const streamFileBatch = vi.fn().mockResolvedValue(new Map());
    vi.spyOn(applier, "applyFileSignals").mockResolvedValue();
    const sharedFilter = ignore().add(["legacy/"]);
    const ctx = {
      key: "codegraph.symbols",
      provider: {
        key: "codegraph.symbols",
        streamFileBatch,
        buildFileSignals: vi.fn(),
        buildChunkSignals: vi.fn(),
        resolveRoot: (p: string) => p,
      } as any,
      effectiveRoot: "/repo",
      ignoreFilter: sharedFilter,
    };

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");
    await phase.onBatch("coll", "/repo", items);
    await phase.drain();

    expect(streamFileBatch).toHaveBeenCalledTimes(1);
    const [root, , options] = streamFileBatch.mock.calls[0];
    expect(root).toBe("/repo");
    expect(options.ignoreFilter).toBe(sharedFilter);
    expect(options.collectionName).toBe("coll");
  });

  it("marks provider failed + writes markPrefetchFailed when streamFileBatch rejects", async () => {
    const qdrant = new MockQdrantManager();
    await seedMarkerPoint(qdrant, "coll");
    const applier = new EnrichmentApplier(qdrant as any);
    const marker = new EnrichmentMarkerStore(qdrant as any);
    await marker.markStart("coll", ["git"], "run-1", "ts");

    const chunkPhase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    const streamFileBatch = vi.fn().mockRejectedValue(new Error("boom"));
    const ctx = buildCtx({ streamFileBatch });

    const phase = new FilePhase(applier, marker, new InlineEnrichmentExecutor());
    phase.bindChunkPhase(chunkPhase);
    chunkPhase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
    phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1", "ts");

    await phase.onBatch("coll", "/repo", items);
    await phase.drain();

    expect(phase.hasPrefetchFailed("git")).toBe(true);
    const m = (await marker.read("coll"))!.git as any;
    expect(m.file.status).toBe("failed");
  });
});
