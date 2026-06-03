import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("drain calls onApplyProgress for each settled apply cycle BEFORE drain resolves (mid-drain heartbeat)", async () => {
    // RED test: proves heartbeat fires DURING the drain — not after it completes.
    // Simulates multiple sequential streaming apply cycles. onApplyProgress must
    // be called once per settled chunkWork promise (not zero times until drain
    // finishes). Today: drain = single Promise.allSettled, onApplyProgress never
    // called. After fix: drain accepts the callback and calls it per settled item.
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    // Three independent batches, each resolves at different times
    const resolvers: (() => void)[] = [];
    const buildChunkSignals = vi.fn().mockImplementation(async () => {
      return new Promise<Map<string, Map<string, unknown>>>((resolve) => {
        resolvers.push(() => {
          resolve(new Map());
        });
      });
    });
    const ctx = buildCtx({ buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");

    const batchA = [
      { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 } },
    ] as any[];
    const batchB = [
      { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/b.ts" }, startLine: 1, endLine: 10 } },
    ] as any[];
    const batchC = [
      { chunkId: "c3", chunk: { metadata: { filePath: "/repo/src/c.ts" }, startLine: 1, endLine: 10 } },
    ] as any[];

    // Queue 3 batches (3 chunkWork promises, each blocked on resolvers)
    phase.onBatchProvider("git", "coll", "/repo", batchA);
    phase.onBatchProvider("git", "coll", "/repo", batchB);
    phase.onBatchProvider("git", "coll", "/repo", batchC);

    const progressCallTimes: number[] = [];
    let drainResolved = false;

    // Start drain with progress callback
    const drainPromise = phase.drain(() => {
      progressCallTimes.push(Date.now());
    });
    void drainPromise.then(() => {
      drainResolved = true;
    });

    // Resolve batches one by one, checking progress fires per resolve
    await new Promise<void>((r) => setImmediate(r));
    expect(drainResolved).toBe(false); // drain hasn't finished yet

    // Resolve first batch
    resolvers[0]?.();
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Progress must have been called at least once BEFORE drain completes
    expect(drainResolved).toBe(false);
    expect(progressCallTimes.length).toBeGreaterThanOrEqual(1);

    // Resolve remaining
    resolvers[1]?.();
    resolvers[2]?.();
    await drainPromise;
    expect(drainResolved).toBe(true);
    // All three applies settled → at least 3 progress calls total
    expect(progressCallTimes.length).toBeGreaterThanOrEqual(3);
  });

  describe("chunkChurnDurationMs wall-clock vs summed per-batch elapsed", () => {
    it("reports wall-clock span of chunk enrichment — not the sum of overlapping per-batch elapseds", async () => {
      // RED before fix: each per-batch elapsed = (semaphore-wait + actual-work).
      // With 3 batches all dispatched at t=0, each captures start=0. When they all
      // complete 100ms later, old code accumulates 3 × 100 = 300ms. Wall-clock = 100ms.
      //
      // We use real timers + controlled resolution: dispatch 3 batches, let them
      // all "run" concurrently (semaphore limit=10), then resolve all together.
      // getMetrics() must return ≤ 150ms (wall-clock), NOT ≥ 250ms (summed).

      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);

      const resolvers: (() => void)[] = [];
      const buildChunkSignals = vi.fn().mockImplementation(
        async () =>
          new Promise<Map<string, Map<string, unknown>>>((resolve) => {
            resolvers.push(() => {
              resolve(new Map());
            });
          }),
      );
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "run-wc");

      const batchA = [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 } },
      ] as any[];
      const batchB = [
        { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/b.ts" }, startLine: 1, endLine: 10 } },
      ] as any[];
      const batchC = [
        { chunkId: "c3", chunk: { metadata: { filePath: "/repo/src/c.ts" }, startLine: 1, endLine: 10 } },
      ] as any[];

      // Dispatch all 3 batches. With semaphore(10) all 3 run concurrently.
      // Each captures start = Date.now() at dispatch time (approximately equal).
      phase.onBatchProvider("git", "coll", "/repo", batchA);
      phase.onBatchProvider("git", "coll", "/repo", batchB);
      phase.onBatchProvider("git", "coll", "/repo", batchC);

      // Yield to let the async work queue up and invoke buildChunkSignals 3 times.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));

      // Now all 3 resolvers are registered. Introduce a real 100ms wait so
      // start timestamps are "old" (they were captured ~100ms ago), then resolve.
      await new Promise<void>((r) => setTimeout(r, 100));
      for (const resolve of resolvers) resolve();

      await phase.drain();

      const metrics = phase.getMetrics();
      // Wall-clock: all 3 batches start at ~t=0, all end at ~t=100 → ~100ms.
      // Old summed: 3 × ~100 = ~300ms.
      // Assert wall-clock (≤ 200ms) — NOT the 300ms sum.
      // Lower bound: at least ~90ms (the 100ms sleep, less some scheduling slack).
      expect(metrics.totalChunkEnrichmentDurationMs).toBeGreaterThanOrEqual(50);
      expect(metrics.totalChunkEnrichmentDurationMs).toBeLessThan(250);
    });
  });

  describe("chunkEnrichmentDurationMs reset between sequential runs", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("reports only the current run duration — not accumulated across daemon lifetime", async () => {
      // Guard: state.chunkEnrichmentDurationMs MUST be reset at run start so
      // a long-lived coordinator reused across many reindex runs reports per-run
      // duration, not an ever-growing lifetime sum (observed symptom: 165360838ms
      // ≈45.9h reported as chunkChurnDurationMs on a session with many reindexes).
      //
      // This test drives TWO sequential enrichment runs on the SAME ChunkPhase
      // instance, calling init() between them (exactly what coordinator.beginRun()
      // does). createState() initializes chunkEnrichmentDurationMs to 0 and
      // init() clears+recreates all states — so the reset happens at init() time.
      //
      // Run 1: chunk work "takes" 100ms (fake time) → getMetrics() = 100ms.
      // Run 2: init() resets, chunk work "takes" 50ms → getMetrics() = 50ms.
      // Regression: if createState() stops initializing to 0 or init() stops
      // clearing states, run 2 reports 150ms (run 1 + run 2 accumulated).

      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);

      // Executor whose runChunkBatch completes only after we advance fake time.
      // Each call resolves after the caller advances the clock by the configured
      // amount — giving deterministic elapsed values.
      const resolvers: (() => void)[] = [];
      const buildChunkSignals = vi.fn().mockImplementation(
        async () =>
          new Promise<Map<string, Map<string, unknown>>>((resolve) => {
            resolvers.push(() => {
              resolve(new Map());
            });
          }),
      );
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());

      // ── RUN 1 ──────────────────────────────────────────────────────────────
      // init() creates fresh per-provider state (chunkEnrichmentDurationMs = 0).
      phase.init(new Map([[ctx.key, ctx]]), "coll", "run-1");

      // Dispatch a streaming batch. Date.now() captured inside runChunkSignals
      // as `start`. The promise is fire-and-forget; it is in chunkWork[].
      phase.onBatch("coll", "/repo", items);

      // Advance clock by 100ms, then settle the batch so the closure computes
      // Date.now() - start = 100. state.chunkEnrichmentDurationMs += 100.
      vi.advanceTimersByTime(100);
      resolvers[0]?.();
      await phase.drain();

      const run1Metrics = phase.getMetrics();
      // After run 1, duration should be ~100ms.
      expect(run1Metrics.totalChunkEnrichmentDurationMs).toBe(100);

      // ── RUN 2 ──────────────────────────────────────────────────────────────
      // Simulate coordinator.beginRun(): re-init the same ChunkPhase instance.
      // This must reset chunkEnrichmentDurationMs to 0 so run 2 starts clean.
      phase.init(new Map([[ctx.key, ctx]]), "coll", "run-2");

      phase.onBatch("coll", "/repo", items);

      // Advance clock by 50ms for run 2's batch.
      vi.advanceTimersByTime(50);
      resolvers[1]?.();
      await phase.drain();

      const run2Metrics = phase.getMetrics();

      // KEY ASSERTION: run 2 duration must be ~50ms (run 2 only).
      // createState() initializes chunkEnrichmentDurationMs to 0, and init()
      // calls this.states.clear() + createState() per provider key — so the
      // reset happens at init() time. If createState() ever stops initializing
      // to 0, or init() stops clearing states, this test catches the regression.
      expect(run2Metrics.totalChunkEnrichmentDurationMs).toBe(50);
    });
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
