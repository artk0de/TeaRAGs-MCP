/**
 * CompletionRunner — final sequence:
 *  1. drain fileWork (streaming file applies)
 *  2. finalize-file pass: provider.finalizeSignals → applyFinalize (codegraph)
 *  3. backfill per ctx (skips defer-providers)
 *  4. markFileFinal per ctx (degraded on residual file-unenriched)
 *  5. aggregate metrics
 *  6. drain chunkWork (git streaming)
 *  7. deferred-chunk pass: chunkPhase.runDeferredChunk (codegraph)
 *  8. markChunkFinal per ctx
 *  9. re-fire stats callback if backfill wrote overlays
 */

import type { EnrichmentExecutor } from "../../../../contracts/types/enrichment-executor.js";
import type { EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentBackfiller } from "./backfiller.js";
import type { ChunkPhase, ChunkPhaseMetrics } from "./chunk-phase.js";
import type { FilePhase } from "./file-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ChunkFinalInput, EnrichmentProvider, ProviderContext } from "./types.js";

export interface CompletionRunnerDeps {
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  applier: EnrichmentApplier;
  markerStore: EnrichmentMarkerStore;
  executor: EnrichmentExecutor;
}

/**
 * Reader for the per-provider, per-level "unenriched chunks" count persisted
 * with the final marker. Owned by Coordinator (which holds the optional
 * EnrichmentRecovery) — passed as a callback so CompletionRunner stays
 * decoupled from Recovery. Resolves to 0 when recovery is unavailable.
 */
export type UnenrichedReader = (coll: string, provider: EnrichmentProvider, level: "file" | "chunk") => Promise<number>;

export class CompletionRunner {
  constructor(private readonly deps: CompletionRunnerDeps) {}

  /**
   * Time one step of the serial tail and report it.
   *
   * This sequence is the last thing a run does, after every overlap has been
   * exhausted, so its cost is wall-clock one-for-one. It used to emit nothing:
   * two taxdome force-reindexes left 121 s and 261 s of silence between the
   * final DEFERRED pass and ALL_COMPLETE, unattributable to any step. Reported
   * on the failure path too — a step that threw still consumed its time.
   */
  private async timedStep<T>(step: string, run: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await run();
    } finally {
      pipelineLog.enrichmentPhase("COMPLETION_STEP", { step, durationMs: Date.now() - startedAt });
    }
  }

  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: UnenrichedReader,
    runStartedAt = "",
    runId = "",
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase } = this.deps;
    const readUnenriched: UnenrichedReader = unenrichedReader ?? (async () => 0);

    // 1. drain prefetch (no-op) + drain streaming fileWork
    await filePhase.awaitPrefetch();
    await filePhase.drain();

    // 2‖3 OVERLAP: the out-of-window file backfill (re-enrich of files the 12mo
    // streaming window missed — the serial tail's dominant cost) depends only on
    // the missed set, now stable after the drain above, and writes a DISJOINT
    // payload subtree (`git.*`) to Qdrant — independent of the codegraph finalize
    // below (DuckDB `cg_*` + `codegraph.*` Qdrant keys) and of the shared applier
    // state (only git miss-tracks; codegraph defers, so `markBackfilled` races
    // nothing the finalize pass touches). Kick it off HERE so its git-blame runs
    // concurrently with the codegraph resolve/SCC/PageRank finalize, collapsing
    // the tail from finalize+backfill to max(finalize, backfill). Awaited below,
    // before the terminal file markers read post-backfill unenriched counts.
    // `backfiller.runFor` is internally try/caught (never rejects), so the
    // in-flight promise can't surface an unhandled rejection before the await.
    const backfillPromise = this.runBackfills(coll, contexts, runStartedAt);

    // 2. finalize-file pass — deferred whole-repo FILE overlays (codegraph graph
    //    metrics) read back after the run sink finishes, applied by the
    //    accumulated chunkMap. git's finalizeSignals returns an empty map.
    await this.timedStep("fileFinalize", async () => this.applyFileFinalize(coll, contexts));

    // 3. await the backfill kicked off before the finalize pass (see 2‖3 above).
    //    Must resolve before the terminal file markers below read per-provider
    //    unenriched counts — they must reflect post-backfill state.
    const backfillOccurred = await this.timedStep("backfillAwait", async () => backfillPromise);

    // 4. markFileFinal per ctx — reconcile to degraded on residual file-unenriched.
    await this.timedStep("fileMarkers", async () => this.markFileTerminals(coll, contexts, readUnenriched, runId));

    // 5. aggregate metrics
    const metrics = this.buildMetrics(contexts, startTime);

    // 6. drain chunkWork (git streaming)
    // Heartbeats now fire at the applier apply-site (EnrichmentApplier.onApply →
    // coordinator.maybeHeartbeat), covering every apply path uniformly. The plain
    // drain() here no longer needs to thread onProgress per-settle.
    await this.timedStep("chunkDrain", async () => chunkPhase.drain());

    // 7. deferred-chunk pass — codegraph buildChunkSignals against the finished
    //    graph with the full accumulated chunkMap, applied via applyChunkSignals.
    //
    // applyChunkSignals fires onApply → maybeHeartbeat when batches land, so
    // lastProgressAt advances during the deferred pass without a separate seam
    // here. The previously-tracked limitation (tea-rags-mcp-xlhu) about the
    // codegraph.chunk phase potentially reporting "stalled" during a long
    // PageRank/resolve pass is resolved: the applier-site hook covers it.
    await this.timedStep("deferredChunk", async () => this.runDeferredChunkPass(coll, contexts));

    const finalChunkMetrics = chunkPhase.getMetrics();
    metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

    // 8. markChunkFinal per ctx
    await this.timedStep("chunkMarkers", async () =>
      this.markChunkTerminals(coll, contexts, readUnenriched, runId, finalChunkMetrics),
    );

    // 9. Re-fire stats callback if backfill wrote post-streaming overlays.
    // First fire (streaming end inside ChunkPhase) preserves the 896f343c
    // contract; this is a strictly-later second fire so listeners (StatsCache)
    // reflect post-backfill state. Listeners must be idempotent.
    if (backfillOccurred) {
      await chunkPhase.fireOnComplete(coll);
    }

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });
    return metrics;
  }

  /**
   * Step 2 — read back each provider's deferred whole-repo FILE overlays and
   * apply them through the accumulated chunkMap. Runs CONCURRENTLY with the
   * out-of-window backfill; see the 2‖3 note in `run`.
   */
  private async applyFileFinalize(coll: string, contexts: ReadonlyMap<string, ProviderContext>): Promise<void> {
    const { filePhase, chunkPhase, executor } = this.deps;
    for (const ctx of contexts.values()) {
      // Method-existence is no longer guarded here: runFinalize returns an
      // empty map when the provider has no finalizeSignals (executor smooths
      // over the optional method), and the size-zero branch below skips the
      // apply step — equivalent to the old `if (!finalizeSignals) continue`.
      if (filePhase.hasPrefetchFailed(ctx.key)) continue;
      const root = ctx.effectiveRoot ?? "";
      // Cross-pass end-of-file-phase flush: the MAIN-thread provider instance
      // buffered node defs via `acceptExtraction` and flushed only complete
      // cadence batches during embedding — its `N mod cadence` remainder is still
      // buffered. `runFinalize` dispatches to a SEPARATE worker instance whose own
      // buffer is empty, so flush the MAIN remainder HERE (on `ctx.provider`, the
      // main instance) and await it BEFORE the worker resolves + upserts edges —
      // nodes-before-edges across the instance boundary. Mirrors the cross-pass
      // `beginExtractionRun` call in `coordinator.beginRun`. No-op off cross-pass
      // (incremental finalize runs on this same instance and owns its own flush)
      // and for providers without the seam (git omits it).
      if (filePhase.crossPassEnabled) await ctx.provider.endExtractionRun?.(coll || undefined);
      // yl9tv Task 5b — thread crossPass so the codegraph worker's finalize
      // drains the main-written input spill (pass-1) before resolving (pass-2),
      // instead of relying on a streamFileBatch that no-opped. Other providers
      // (git) ignore the flag.
      const fileOverlays = await executor.runFinalize(ctx.provider, root, {
        collectionName: coll || undefined,
        crossPass: filePhase.crossPassEnabled,
        // The run's per-file hashes, stamped onto the rows pass-2 writes (bd
        // tea-rags-mcp-o317j). Finalize is the one dispatch every ingest path
        // makes, and pass-2 — the only writer of those rows — runs inside it, so
        // this is what keeps a first index / `--force` from persisting NULL and
        // making the next run repair the whole corpus. Providers that keep no
        // per-file store (git) ignore it.
        contentHashes: filePhase.runContentHashes,
      });
      if (fileOverlays.size > 0) {
        await filePhase.applyFinalize(coll, ctx, fileOverlays, chunkPhase.getDeferredChunkMap(ctx.key));
      }
    }
    await filePhase.drain();
  }

  /**
   * Report a marker step's two halves apart.
   *
   * A marker step does exactly two things: scan for residual unenriched points,
   * and write the terminal marker. The write is `wait: true`, which makes it a
   * BARRIER on every `wait: false` payload write the preceding apply step
   * queued — so a marker step's wall clock is mostly not its own work. The
   * unenriched scans measure ~6ms on taxdome since the v14 payload indexes while
   * the steps measured 11.6s and 11.4s; without this split that gap is
   * unattributable and invites re-optimising a scan that is already free.
   */
  private reportMarkerSplit(step: string, scanMs: number, writeMs: number): void {
    pipelineLog.enrichmentPhase("COMPLETION_MARKER_SPLIT", { step, scanMs, writeMs });
  }

  /**
   * Step 4 — terminal FILE marker per provider. Reads post-backfill unenriched
   * counts, so it must run after the backfill await.
   */
  private async markFileTerminals(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    readUnenriched: UnenrichedReader,
    runId: string,
  ): Promise<void> {
    const { filePhase, applier, markerStore } = this.deps;
    let scanMs = 0;
    let writeMs = 0;
    for (const ctx of contexts.values()) {
      const scanStartedAt = Date.now();
      const fileUnenriched = await readUnenriched(coll, ctx.provider, "file");
      scanMs += Date.now() - scanStartedAt;
      const writeStartedAt = Date.now();
      const fileStatus = filePhase.hasPrefetchFailed(ctx.key)
        ? "failed"
        : fileUnenriched > 0
          ? "degraded"
          : "completed";
      await markerStore.markFileFinal(coll, ctx.key, {
        runId,
        status: fileStatus,
        durationMs: filePhase.getPrefetchDurationMs(ctx.key),
        unenrichedChunks: fileUnenriched,
        matchedFiles: applier.matchedFiles,
        missedFiles: applier.missedFiles,
        ignoredFiles: applier.ignoredFiles,
        // Carry the prefetch failure cause into the TERMINAL marker — this
        // write used to overwrite markPrefetchFailed's errorMessage, leaving
        // `failed` with no cause anywhere (worker stderr is detached).
        ...(fileStatus === "failed" ? { errorMessage: filePhase.getPrefetchError(ctx.key) } : {}),
      });
      writeMs += Date.now() - writeStartedAt;
    }
    this.reportMarkerSplit("fileMarkers", scanMs, writeMs);
  }

  /**
   * Step 5 (+5b) — snapshot the run's counters. Top-level fields stay
   * coordinator-owned and git-historical for back-compat; provider-specific
   * counters (codegraph extractedFiles, etc.) go under `byProvider`.
   *
   * `chunkChurnDurationMs` is a PRELIMINARY read here — the deferred-chunk pass
   * (step 7) still has to run, and `run` overwrites the field afterwards.
   */
  private buildMetrics(contexts: ReadonlyMap<string, ProviderContext>, startTime: number): EnrichmentMetrics {
    const { filePhase, chunkPhase, applier } = this.deps;
    const fileMetrics = filePhase.getMetrics();
    const chunkMetrics = chunkPhase.getMetrics();
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (startTime || Date.now()),
      matchedFiles: applier.matchedFiles,
      missedFiles: applier.missedFiles,
      missedPathSamples: [...applier.missedPathSamples],
    };

    let byProvider: Record<string, Record<string, unknown>> | undefined;
    for (const ctx of contexts.values()) {
      const providerMetrics = ctx.provider.getRunMetrics?.();
      if (!providerMetrics) continue;
      byProvider ??= {};
      byProvider[ctx.key] = providerMetrics;
    }
    if (byProvider) metrics.byProvider = byProvider;
    return metrics;
  }

  /**
   * Step 7 — codegraph buildChunkSignals against the finished graph, keyed by
   * the full accumulated chunkMap.
   */
  private async runDeferredChunkPass(coll: string, contexts: ReadonlyMap<string, ProviderContext>): Promise<void> {
    const { filePhase, chunkPhase } = this.deps;
    for (const ctx of contexts.values()) {
      if (!ctx.provider.defersChunkEnrichment || filePhase.hasPrefetchFailed(ctx.key)) continue;
      const cm = chunkPhase.getDeferredChunkMap(ctx.key);
      if (cm.size > 0) {
        await chunkPhase.runDeferredChunk(coll, ctx, ctx.effectiveRoot ?? "", cm);
      }
    }
  }

  /** Step 8 — terminal CHUNK marker per provider, after the deferred pass. */
  private async markChunkTerminals(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    readUnenriched: UnenrichedReader,
    runId: string,
    finalChunkMetrics: ChunkPhaseMetrics,
  ): Promise<void> {
    const { filePhase, chunkPhase, markerStore } = this.deps;
    let scanMs = 0;
    let writeMs = 0;
    for (const ctx of contexts.values()) {
      const scanStartedAt = Date.now();
      const chunkUnenriched = await readUnenriched(coll, ctx.provider, "chunk");
      scanMs += Date.now() - scanStartedAt;
      const writeStartedAt = Date.now();
      let chunkStatus: ChunkFinalInput["status"];
      if (filePhase.hasPrefetchFailed(ctx.key) || chunkPhase.hasChunkEnrichmentFailed(ctx.key)) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }
      await markerStore.markChunkFinal(coll, ctx.key, {
        runId,
        status: chunkStatus,
        // iqpuu: per-provider wall span — the marker no longer inherits the
        // cross-provider span (deferred codegraph used to stretch git's).
        durationMs: finalChunkMetrics.providerDurationsMs[ctx.key] ?? 0,
        unenrichedChunks: chunkUnenriched,
        ...(chunkStatus === "failed" ? { errorMessage: filePhase.getPrefetchError(ctx.key) } : {}),
      });
      writeMs += Date.now() - writeStartedAt;
    }
    this.reportMarkerSplit("chunkMarkers", scanMs, writeMs);
  }

  /**
   * Backfill file+chunk signals for every non-deferring provider's missed files.
   * Extracted so the completion sequence can OVERLAP it with the codegraph
   * finalize pass (see `run` step 2‖3). Skips defer-providers (codegraph) — they
   * have no miss-tracking; their overlays come from `applyFinalize`. Returns
   * whether any missed files existed (drives the post-backfill stats re-fire).
   * `backfiller.runFor` is internally try/caught, so this never rejects.
   */
  private async runBackfills(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    runStartedAt: string,
  ): Promise<boolean> {
    const { filePhase, backfiller, applier } = this.deps;
    if (applier.getMissedFileChunks().size === 0) return false;
    for (const ctx of contexts.values()) {
      if (filePhase.hasPrefetchFailed(ctx.key) || ctx.provider.defersChunkEnrichment) continue;
      await backfiller.runFor(coll, ctx, runStartedAt);
    }
    return true;
  }
}
