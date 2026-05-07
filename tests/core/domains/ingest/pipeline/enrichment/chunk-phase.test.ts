import { describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { ChunkPhase } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/chunk-phase.js";

function buildCtx(buildChunkSignals = vi.fn().mockResolvedValue(new Map())) {
  return {
    key: "git",
    provider: { key: "git", buildChunkSignals } as any,
    effectiveRoot: "/repo",
    ignoreFilter: null,
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
  it("onBatch dispatches streaming work with semaphore-bounded concurrency", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
  });

  it("enrichRemaining skips files already enriched by streaming", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");
    phase.onBatch("coll", "/repo", items);
    await phase.drain();
    ctx.provider.buildChunkSignals.mockClear();
    phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", [{ chunkId: "c1", startLine: 1, endLine: 10 }]]]));
    await phase.drain();
    expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
  });

  it("setOnComplete fires when at least one provider succeeded", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const ctx = buildCtx();
    const phase = new ChunkPhase(applier);
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
    const ctx = buildCtx(buildChunkSignals);
    const phase = new ChunkPhase(applier);
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
