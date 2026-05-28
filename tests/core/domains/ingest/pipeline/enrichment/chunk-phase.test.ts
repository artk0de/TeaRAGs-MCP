import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";

function buildCtx(overrides: Record<string, unknown> = {}) {
  return {
    key: "git",
    provider: { key: "git", buildChunkSignals: vi.fn().mockResolvedValue(new Map()), ...overrides } as any,
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

describe("ChunkPhase", () => {
  it("onBatch dispatches streaming work immediately for a streaming provider", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("onBatch accumulates (no dispatch) for a defersChunkEnrichment provider", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx({ defersChunkEnrichment: true });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", items);
    await phase.drain();

    // No streaming dispatch for deferred providers.
    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
    // But the batch's chunkMap is accumulated for the deferred pass.
    const cm = phase.getDeferredChunkMap("git");
    expect(cm.has("src/a.ts")).toBe(true);
    expect(cm.get("src/a.ts")!.length).toBe(1);
  });

  it("runDeferredChunk calls buildChunkSignals + applyChunkSignals against the finished graph", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { fanIn: 2 }]])]]));
    const applySpy = vi.spyOn(applier, "applyChunkSignals").mockResolvedValue(1);
    const ctx = buildCtx({ defersChunkEnrichment: true, buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.onBatch("coll", "/repo", items); // accumulate
    const cm = phase.getDeferredChunkMap("git");
    await phase.runDeferredChunk("coll", ctx, "/repo", cm);

    expect(buildChunkSignals).toHaveBeenCalledWith(
      "/repo",
      cm,
      expect.objectContaining({ skipCache: true, collectionName: "coll" }),
    );
    expect(applySpy).toHaveBeenCalled();
    // After the pass the deferred map is reset.
    expect(phase.getDeferredChunkMap("git").size).toBe(0);
  });

  it("enrichRemaining skips defer-providers", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx({ defersChunkEnrichment: true });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));
    await phase.drain();

    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("enrichRemaining skips files already enriched by streaming", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    ctx.provider.buildChunkSignals.mockClear();
    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("markFailed suppresses streaming dispatch", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
    phase.markFailed("git");
    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("setOnComplete fires when at least one provider succeeded", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
    const cb = vi.fn().mockResolvedValue(undefined);
    phase.setOnComplete(cb);
    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));
    await phase.drain();
    await new Promise((r) => setImmediate(r));
    expect(cb).toHaveBeenCalledWith("coll");
  });

  it("onChunkEnrichmentComplete callback waits for streaming work to settle", async () => {
    // Regression: when remaining.size === 0 (full reindex — streaming covered
    // every file), providerPromises = [Promise.resolve(true)] settles
    // instantly. Callback must wait for in-flight streaming work as well —
    // otherwise downstream refreshStatsByCollection reads partial chunk
    // payloads and caches stale stats.
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    let streamingResolved = false;
    const buildChunkSignals = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      streamingResolved = true;
      return new Map();
    });
    const ctx = buildCtx({ buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

    let callbackFiredWhileStreamPending = false;
    phase.setOnComplete(async () => {
      if (!streamingResolved) callbackFiredWhileStreamPending = true;
    });

    phase.onBatch("coll", "/repo", items);
    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));

    await phase.drain();
    await new Promise((r) => setImmediate(r));

    expect(callbackFiredWhileStreamPending).toBe(false);
  });
});
