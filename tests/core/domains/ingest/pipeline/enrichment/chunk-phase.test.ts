import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentBackfiller } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/backfiller.js";
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

  it("applier.onApply fires for each settled apply cycle BEFORE drain resolves (applier-site heartbeat)", async () => {
    // Adapted from the old drain(onApplyProgress) test: heartbeats now fire at
    // the applier apply-site (EnrichmentApplier.onApply) — not at drain().
    // The contract: onApply is called once per completed runChunkSignals batch,
    // DURING the drain (not only after drain resolves), covering all apply paths.
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);

    // Three independent batches, each resolves at different times.
    // buildChunkSignals returns a non-empty overlay so applyChunkSignals writes
    // at least one chunk and triggers onApply.
    const resolvers: (() => void)[] = [];
    const buildChunkSignals = vi.fn().mockImplementation(async (_root: string, chunkMap: Map<string, unknown[]>) => {
      const overlays = new Map<string, Map<string, unknown>>();
      for (const [rel, entries] of chunkMap) {
        const inner = new Map<string, unknown>();
        for (const e of entries as { chunkId: string }[]) inner.set(e.chunkId, { commitCount: 1 });
        overlays.set(rel, inner);
      }
      return new Promise<typeof overlays>((resolve) => {
        resolvers.push(() => {
          resolve(overlays);
        });
      });
    });
    const ctx = buildCtx({ buildChunkSignals });
    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");

    const progressCallTimes: number[] = [];
    // Wire applier.onApply — simulates what the coordinator does.
    applier.onApply = () => {
      progressCallTimes.push(Date.now());
    };

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

    let drainResolved = false;
    const drainPromise = phase.drain();
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

    // onApply (via applyChunkSignals) must have fired BEFORE drain completes
    expect(drainResolved).toBe(false);
    expect(progressCallTimes.length).toBeGreaterThanOrEqual(1);

    // Resolve remaining
    resolvers[1]?.();
    resolvers[2]?.();
    await drainPromise;
    expect(drainResolved).toBe(true);
    // All three applies settled → at least 3 onApply calls total
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

  describe("shared run-scoped blobReader (kc93)", () => {
    it("creates ONE reader across many streaming batches, threads it via opts, closes once at drain", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);

      const close = vi.fn().mockResolvedValue(undefined);
      const sharedReader = { read: vi.fn(), close };
      const blobReaderFactory = vi.fn().mockReturnValue(sharedReader);

      const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor(), blobReaderFactory);
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

      phase.onBatchProvider("git", "coll", "/repo", batchA);
      phase.onBatchProvider("git", "coll", "/repo", batchB);
      phase.onBatchProvider("git", "coll", "/repo", batchC);

      // The reader is lazily created ONCE for the run, before drain.
      expect(blobReaderFactory).toHaveBeenCalledTimes(1);
      expect(blobReaderFactory).toHaveBeenCalledWith("/repo");

      // Reader is still open until drain completes the run's chunk work.
      expect(close).not.toHaveBeenCalled();

      await phase.drain();

      // Every per-batch buildChunkSignals call received the SAME shared
      // reader (the factory result is awaited, so dispatch lands a microtick
      // after onBatchProvider — asserted post-drain).
      expect(buildChunkSignals).toHaveBeenCalledTimes(3);
      for (const call of buildChunkSignals.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ blobReader: sharedReader }));
      }

      // Closed exactly once at end of drain — no idle git process left behind.
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("awaits an async blobReaderFactory once and shares the RESOLVED reader (vcs adapter path)", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);

      const close = vi.fn().mockResolvedValue(undefined);
      const sharedReader = { read: vi.fn(), close };
      // es-git adapters open asynchronously — the factory returns a Promise.
      const blobReaderFactory = vi.fn().mockResolvedValue(sharedReader);

      const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor(), blobReaderFactory);
      phase.init(new Map([[ctx.key, ctx]]), "coll", "2026-05-07T10:00:00Z");

      const batchA = [
        { chunkId: "c1", chunk: { metadata: { filePath: "/repo/src/a.ts" }, startLine: 1, endLine: 10 } },
      ] as any[];
      const batchB = [
        { chunkId: "c2", chunk: { metadata: { filePath: "/repo/src/b.ts" }, startLine: 1, endLine: 10 } },
      ] as any[];

      phase.onBatchProvider("git", "coll", "/repo", batchA);
      phase.onBatchProvider("git", "coll", "/repo", batchB);

      expect(blobReaderFactory).toHaveBeenCalledTimes(1);
      expect(blobReaderFactory).toHaveBeenCalledWith("/repo");

      await phase.drain();

      // Both batches saw the RESOLVED reader, never the Promise wrapper.
      expect(buildChunkSignals).toHaveBeenCalledTimes(2);
      for (const call of buildChunkSignals.mock.calls) {
        expect(call[2]).toEqual(expect.objectContaining({ blobReader: sharedReader }));
      }
      expect(close).toHaveBeenCalledTimes(1);
    });

    it("does not create a reader when no factory is injected (fallback to per-call reader)", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      phase.onBatch("coll", "/repo", items);
      await phase.drain();

      // No factory → opts carries no blobReader; provider falls back to its own.
      expect(buildChunkSignals).toHaveBeenCalledTimes(1);
      expect(buildChunkSignals.mock.calls[0][2]).not.toHaveProperty("blobReader");
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

  it("skips chunk-churn for scope=none and scope=file-only files", async () => {
    const qdrant = new MockQdrantManager();
    const applier = new EnrichmentApplier(qdrant as any);
    const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
    const ctx = buildCtx({
      buildChunkSignals,
      shouldEnrich: (f: { classification: { isGenerated: boolean; isDocumentation: boolean } }) =>
        f.classification.isGenerated ? "none" : f.classification.isDocumentation ? "file-only" : "full",
    });

    const threeFiles = [
      { chunkId: "g1", chunk: { metadata: { filePath: "/repo/db/schema.rb" }, startLine: 1, endLine: 10 } } as any,
      { chunkId: "d1", chunk: { metadata: { filePath: "/repo/README.md" }, startLine: 1, endLine: 10 } } as any,
      {
        chunkId: "s1",
        chunk: { metadata: { filePath: "/repo/app/models/user.rb" }, startLine: 1, endLine: 10 },
      } as any,
    ];

    const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
    phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
    phase.onBatch("coll", "/repo", threeFiles);
    await phase.drain();

    const enrichedRel = new Set(
      buildChunkSignals.mock.calls.flatMap((c) => [...(c[1] as Map<string, unknown>).keys()]),
    );
    expect(enrichedRel.has("app/models/user.rb")).toBe(true);
    expect(enrichedRel.has("db/schema.rb")).toBe(false);
    expect(enrichedRel.has("README.md")).toBe(false);
  });

  describe("streaming coverage at batch ARRIVAL (bd tea-rags-mcp-7gnre)", () => {
    const batchOf = (rel: string, chunkId: string) =>
      [{ chunkId, chunk: { metadata: { filePath: `/repo/${rel}` }, startLine: 1, endLine: 10 } }] as any[];
    const entriesOf = (chunkId: string) => [{ chunkId, startLine: 1, endLine: 10 }];
    const walkedFiles = (buildChunkSignals: ReturnType<typeof vi.fn>) =>
      buildChunkSignals.mock.calls.flatMap((c) => [...(c[1] as Map<string, unknown>).keys()]);

    it("marks coverage at batch arrival but defers dispatch until the file-work gate resolves", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => {
        releaseGate = r;
      });

      // Batch ARRIVES while its file work is still in flight (pending gate).
      phase.onBatchProvider("git", "coll", "/repo", batchOf("src/a.ts", "c1"), gate);
      await new Promise((r) => setImmediate(r));

      // Dispatch is file-work-gated: the walk must NOT have started yet.
      expect(buildChunkSignals).not.toHaveBeenCalled();

      // The post-flush snapshot must ALREADY exclude src/a.ts — its batch is
      // queued and will be covered by its own gated dispatch.
      phase.enrichRemaining(
        "coll",
        "/repo",
        new Map([
          ["src/a.ts", entriesOf("c1")],
          ["src/b.ts", entriesOf("c2")],
        ]),
      );
      await new Promise((r) => setImmediate(r));
      expect(walkedFiles(buildChunkSignals)).toContain("src/b.ts");
      expect(walkedFiles(buildChunkSignals)).not.toContain("src/a.ts");

      releaseGate();
      await phase.drain();

      // After the gate resolves, src/a.ts is walked by its own batch — ONCE.
      expect(walkedFiles(buildChunkSignals).filter((f) => f === "src/a.ts")).toHaveLength(1);
      expect(walkedFiles(buildChunkSignals).filter((f) => f === "src/b.ts")).toHaveLength(1);
    });

    it("total files walked across multi-batch streaming + post-flush equals unique files (no 2x)", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      // Echo overlays for every input file/chunk so applied counts are real.
      const buildChunkSignals = vi.fn().mockImplementation(async (_root: string, chunkMap: Map<string, any[]>) => {
        const overlays = new Map<string, Map<string, unknown>>();
        for (const [rel, entries] of chunkMap) {
          overlays.set(rel, new Map(entries.map((e) => [e.chunkId, { commitCount: 1 }])));
        }
        return overlays;
      });
      const ctx = buildCtx({ buildChunkSignals });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");
      const applySpy = vi.spyOn(applier, "applyChunkSignals");

      let releaseA!: () => void;
      let releaseB!: () => void;
      const gateA = new Promise<void>((r) => {
        releaseA = r;
      });
      const gateB = new Promise<void>((r) => {
        releaseB = r;
      });

      // Two streaming batches arrive, both file-work-gated (in flight).
      phase.onBatchProvider("git", "coll", "/repo", batchOf("src/a.ts", "c1"), gateA);
      phase.onBatchProvider("git", "coll", "/repo", batchOf("src/b.ts", "c2"), gateB);

      // Post-flush catch-up over the FULL chunk map (a, b in flight; c uncovered).
      phase.enrichRemaining(
        "coll",
        "/repo",
        new Map([
          ["src/a.ts", entriesOf("c1")],
          ["src/b.ts", entriesOf("c2")],
          ["src/c.ts", entriesOf("c3")],
        ]),
      );

      releaseA();
      releaseB();
      await phase.drain();
      await new Promise((r) => setImmediate(r));

      // Every file walked exactly once — 3 walks for 3 unique files.
      const walked = walkedFiles(buildChunkSignals);
      expect(walked.sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);

      // Overlay-apply proof: total overlays applied == total chunks (3, not 2x).
      let overlaysApplied = 0;
      for (const call of applySpy.mock.calls) {
        for (const inner of (call[2] as Map<string, Map<string, unknown>>).values()) overlaysApplied += inner.size;
      }
      expect(overlaysApplied).toBe(3);
    });

    it("a file marked at arrival whose streaming walk FAILS is still covered by backfill (safety net intact)", async () => {
      const qdrant = new MockQdrantManager();
      await qdrant.createCollection("coll", 384);
      await qdrant.addPoints("coll", [{ id: "c1", vector: new Array(384).fill(0.1), payload: {} }]);
      const applier = new EnrichmentApplier(qdrant as any);

      // Streaming walk fails once (the gated batch), then succeeds (backfill).
      const buildChunkSignals = vi
        .fn()
        .mockRejectedValueOnce(new Error("walk failed"))
        .mockResolvedValue(new Map([["src/a.ts", new Map([["c1", { churnRatio: 1 }]])]]));
      const buildFileSignals = vi.fn().mockResolvedValue(new Map([["src/a.ts", { commitCount: 2 }]]));
      const ctx = buildCtx({ buildChunkSignals, buildFileSignals });
      const executor = new InlineEnrichmentExecutor();
      const phase = new ChunkPhase(applier, executor);
      phase.init(new Map([[ctx.key, ctx]]), "coll", "t0");

      let releaseGate!: () => void;
      const gate = new Promise<void>((r) => {
        releaseGate = r;
      });
      const items = batchOf("src/a.ts", "c1");
      phase.onBatchProvider("git", "coll", "/repo", items, gate);

      // src/a.ts is marked at arrival → excluded from the post-flush walk.
      phase.enrichRemaining("coll", "/repo", new Map([["src/a.ts", entriesOf("c1")]]));
      releaseGate();
      await phase.drain();
      await new Promise((r) => setImmediate(r));

      // The streaming walk failed → the chunk got NO overlay from streaming.
      expect(buildChunkSignals).toHaveBeenCalledTimes(1);

      // File-phase miss (no file overlay landed for src/a.ts) feeds the tracker…
      await applier.applyFileSignals("coll", "git", new Map(), "/repo", items, undefined, "t0");
      expect(applier.getMissedFileChunks().has("src/a.ts")).toBe(true);

      // …and backfill re-fetches file AND chunk overlays despite the arrival mark.
      const backfiller = new EnrichmentBackfiller(applier, qdrant as any, executor);
      await backfiller.runFor("coll", ctx as any, "t0");

      const point = (await qdrant.getPoint("coll", "c1"))!;
      expect((point.payload as any).git.file.commitCount).toBe(2);
      expect((point.payload as any).git.chunk.churnRatio).toBe(1);
    });
  });

  // bd tea-rags-mcp-okra9 — the chunk-level half of the skip stamp. Every path
  // below this point filters declined files out silently, so unless the drop
  // site records the decline the run ends with those points unmarked and the
  // next run's recovery scan pays for them.
  describe("skip stamps for policy-declined chunks", () => {
    const declineDocsAtChunkLevel = (f: { classification: { isDocumentation: boolean } }) =>
      f.classification.isDocumentation ? "file-only" : "full";

    const docItem = {
      chunkId: "d1",
      chunk: { metadata: { filePath: "/repo/docs/guide.md" }, startLine: 1, endLine: 20 },
    } as any;

    it("stamps a file the provider enriches at file level but declines at chunk level", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      const stampSpy = vi.spyOn(applier, "applySkipStamps").mockResolvedValue(1);
      const ctx = buildCtx({ shouldEnrich: declineDocsAtChunkLevel });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      phase.onBatch("coll", "/repo", [...items, docItem]);
      await phase.drain();

      expect(stampSpy).toHaveBeenCalledWith("coll", "git", "chunk", [{ id: "d1", skippedAs: "documentation" }]);
      // The churn walk still runs, for the source file only.
      expect(ctx.provider.buildChunkSignals).toHaveBeenCalledTimes(1);
    });

    it("stamps a fully declined batch even though no walk is dispatched", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      const stampSpy = vi.spyOn(applier, "applySkipStamps").mockResolvedValue(1);
      const ctx = buildCtx({ shouldEnrich: declineDocsAtChunkLevel });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      phase.onBatch("coll", "/repo", [docItem]);
      await phase.drain();

      expect(stampSpy).toHaveBeenCalledWith("coll", "git", "chunk", [{ id: "d1", skippedAs: "documentation" }]);
      expect(ctx.provider.buildChunkSignals).not.toHaveBeenCalled();
    });

    it("stamps a deferred provider's declines at accumulation time", async () => {
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      const stampSpy = vi.spyOn(applier, "applySkipStamps").mockResolvedValue(1);
      const ctx = buildCtx({
        defersChunkEnrichment: true,
        shouldEnrich: (f: { classification: { isTest: boolean } }) => (f.classification.isTest ? "none" : "full"),
      });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      phase.onBatch("coll", "/repo", [
        ...items,
        {
          chunkId: "t1",
          chunk: { metadata: { filePath: "/repo/spec/models/user_spec.rb" }, startLine: 1, endLine: 30 },
        } as any,
      ]);
      await phase.drain();

      expect(stampSpy).toHaveBeenCalledWith("coll", "git", "chunk", [{ id: "t1", skippedAs: "test" }]);
    });

    it("runDeferredChunk leaves a declined file to its stamp instead of enriching it", async () => {
      // The accumulated map is deliberately unfiltered — FilePhase.applyFinalize
      // reads it to tell ignored from missed at FILE level — so the chunk-level
      // policy has to be applied at the dispatch. Without it the deferred pass
      // stamps enrichedAt over the skippedAs written at accumulation time and
      // the point carries both terminal markers.
      const qdrant = new MockQdrantManager();
      const applier = new EnrichmentApplier(qdrant as any);
      vi.spyOn(applier, "applySkipStamps").mockResolvedValue(1);
      const buildChunkSignals = vi.fn().mockResolvedValue(new Map());
      const applySpy = vi.spyOn(applier, "applyChunkSignals").mockResolvedValue(1);
      const ctx = buildCtx({
        defersChunkEnrichment: true,
        buildChunkSignals,
        shouldEnrich: (f: { classification: { isTest: boolean } }) => (f.classification.isTest ? "none" : "full"),
      });
      const phase = new ChunkPhase(applier, new InlineEnrichmentExecutor());
      phase.init(new Map([[ctx.key, ctx]]), "coll", "ts");

      phase.onBatch("coll", "/repo", [
        ...items,
        {
          chunkId: "t1",
          chunk: { metadata: { filePath: "/repo/spec/models/user_spec.rb" }, startLine: 1, endLine: 30 },
        } as any,
      ]);
      await phase.drain();
      await phase.runDeferredChunk("coll", ctx as any, "/repo", phase.getDeferredChunkMap("git"));

      const dispatched = buildChunkSignals.mock.calls[0][1] as Map<string, unknown>;
      expect([...dispatched.keys()]).toEqual(["src/a.ts"]);
      // allRequestedChunkIds drives the "no signals found" enrichedAt stamp —
      // the declined chunk must not be in it.
      expect(applySpy.mock.calls[0][4]).toEqual(new Set(["c1"]));
    });
  });
});
