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
import type { ChunkPhase } from "./chunk-phase.js";
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

  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: UnenrichedReader,
    runStartedAt = "",
    runId = "",
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase, backfiller, applier, markerStore, executor } = this.deps;
    const readUnenriched: UnenrichedReader = unenrichedReader ?? (async () => 0);

    // 1. drain prefetch (no-op) + drain streaming fileWork
    await filePhase.awaitPrefetch();
    await filePhase.drain();

    // 2. finalize-file pass — deferred whole-repo FILE overlays (codegraph graph
    //    metrics) read back after the run sink finishes, applied by the
    //    accumulated chunkMap. git's finalizeSignals returns an empty map.
    for (const ctx of contexts.values()) {
      // Method-existence is no longer guarded here: runFinalize returns an
      // empty map when the provider has no finalizeSignals (executor smooths
      // over the optional method), and the size-zero branch below skips the
      // apply step — equivalent to the old `if (!finalizeSignals) continue`.
      if (filePhase.hasPrefetchFailed(ctx.key)) continue;
      const root = ctx.effectiveRoot ?? "";
      // yl9tv Task 5b — thread crossPass so the codegraph worker's finalize
      // drains the main-written input spill (pass-1) before resolving (pass-2),
      // instead of relying on a streamFileBatch that no-opped. Other providers
      // (git) ignore the flag.
      const fileOverlays = await executor.runFinalize(ctx.provider, root, {
        collectionName: coll || undefined,
        crossPass: filePhase.crossPassEnabled,
      });
      if (fileOverlays.size > 0) {
        await filePhase.applyFinalize(coll, ctx, fileOverlays, chunkPhase.getDeferredChunkMap(ctx.key));
      }
    }
    await filePhase.drain();

    // 3. backfill per ctx — skips defer-providers (they have no miss-tracking;
    //    their file overlays came from applyFinalize).
    let backfillOccurred = false;
    if (applier.getMissedFileChunks().size > 0) {
      backfillOccurred = true;
      for (const ctx of contexts.values()) {
        if (filePhase.hasPrefetchFailed(ctx.key) || ctx.provider.defersChunkEnrichment) continue;
        await backfiller.runFor(coll, ctx, runStartedAt);
      }
    }

    // 4. markFileFinal per ctx — reconcile to degraded on residual file-unenriched.
    for (const ctx of contexts.values()) {
      const fileUnenriched = await readUnenriched(coll, ctx.provider, "file");
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
      });
    }

    // 5. aggregate metrics
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

    // 5b. provider-specific counters (codegraph extractedFiles, etc.).
    // Top-level fields above remain coordinator-owned and git-historical
    // for back-compat; new providers expose their counters here.
    let byProvider: Record<string, Record<string, unknown>> | undefined;
    for (const ctx of contexts.values()) {
      const providerMetrics = ctx.provider.getRunMetrics?.();
      if (!providerMetrics) continue;
      byProvider ??= {};
      byProvider[ctx.key] = providerMetrics;
    }
    if (byProvider) metrics.byProvider = byProvider;

    // 6. drain chunkWork (git streaming)
    // Heartbeats now fire at the applier apply-site (EnrichmentApplier.onApply →
    // coordinator.maybeHeartbeat), covering every apply path uniformly. The plain
    // drain() here no longer needs to thread onProgress per-settle.
    await chunkPhase.drain();

    // 7. deferred-chunk pass — codegraph buildChunkSignals against the finished
    //    graph with the full accumulated chunkMap, applied via applyChunkSignals.
    //
    // applyChunkSignals fires onApply → maybeHeartbeat when batches land, so
    // lastProgressAt advances during the deferred pass without a separate seam
    // here. The previously-tracked limitation (tea-rags-mcp-xlhu) about the
    // codegraph.chunk phase potentially reporting "stalled" during a long
    // PageRank/resolve pass is resolved: the applier-site hook covers it.
    for (const ctx of contexts.values()) {
      if (!ctx.provider.defersChunkEnrichment || filePhase.hasPrefetchFailed(ctx.key)) continue;
      const cm = chunkPhase.getDeferredChunkMap(ctx.key);
      if (cm.size > 0) {
        await chunkPhase.runDeferredChunk(coll, ctx, ctx.effectiveRoot ?? "", cm);
      }
    }

    const finalChunkMetrics = chunkPhase.getMetrics();
    metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

    // 8. markChunkFinal per ctx
    for (const ctx of contexts.values()) {
      const chunkUnenriched = await readUnenriched(coll, ctx.provider, "chunk");
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
        durationMs: finalChunkMetrics.totalChunkEnrichmentDurationMs,
        unenrichedChunks: chunkUnenriched,
      });
    }

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
}
