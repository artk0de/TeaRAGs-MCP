/**
 * CompletionRunner — final 7-step sequence:
 *  1. drain prefetch
 *  2. drain fileWork
 *  3. backfill per ctx
 *  4. markFileFinal per ctx
 *  5. aggregate metrics
 *  6. drain chunkWork
 *  7. markChunkFinal per ctx
 */

import type { EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentBackfiller } from "./backfiller.js";
import type { ChunkPhase } from "./chunk-phase.js";
import type { FilePhase } from "./file-phase.js";
import type { EnrichmentMarkerStore } from "./marker-store.js";
import type { ChunkFinalInput, ProviderContext } from "./types.js";

export interface CompletionRunnerDeps {
  filePhase: FilePhase;
  chunkPhase: ChunkPhase;
  backfiller: EnrichmentBackfiller;
  applier: EnrichmentApplier;
  markerStore: EnrichmentMarkerStore;
}

/**
 * Reader for the per-provider, per-level "unenriched chunks" count persisted
 * with the final marker. Owned by Coordinator (which holds the optional
 * EnrichmentRecovery) — passed as a callback so CompletionRunner stays
 * decoupled from Recovery. Resolves to 0 when recovery is unavailable.
 */
export type UnenrichedReader = (coll: string, providerKey: string, level: "file" | "chunk") => Promise<number>;

export class CompletionRunner {
  constructor(private readonly deps: CompletionRunnerDeps) {}

  async run(
    coll: string,
    contexts: ReadonlyMap<string, ProviderContext>,
    startTime: number,
    unenrichedReader?: UnenrichedReader,
    runStartedAt = "",
  ): Promise<EnrichmentMetrics> {
    const { filePhase, chunkPhase, backfiller, applier, markerStore } = this.deps;
    const readUnenriched: UnenrichedReader = unenrichedReader ?? (async () => 0);

    // 1. drain prefetch
    await filePhase.awaitPrefetch();

    // 2. drain fileWork
    await filePhase.drain();

    // 3. backfill per ctx
    let backfillOccurred = false;
    if (applier.getMissedFileChunks().size > 0) {
      backfillOccurred = true;
      for (const ctx of contexts.values()) {
        if (filePhase.hasPrefetchFailed(ctx.key)) continue;
        await backfiller.runFor(coll, ctx, runStartedAt);
      }
    }

    // 4. markFileFinal per ctx
    for (const ctx of contexts.values()) {
      const fileUnenriched = await readUnenriched(coll, ctx.key, "file");
      await markerStore.markFileFinal(coll, ctx.key, {
        status: filePhase.hasPrefetchFailed(ctx.key) ? "failed" : "completed",
        durationMs: filePhase.getPrefetchDurationMs(ctx.key),
        unenrichedChunks: fileUnenriched,
        matchedFiles: applier.matchedFiles,
        missedFiles: applier.missedFiles,
      });
    }

    // 5. aggregate metrics
    const fileMetrics = filePhase.getMetrics();
    const chunkMetrics = chunkPhase.getMetrics();
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (startTime || Date.now()),
      matchedFiles: applier.matchedFiles,
      missedFiles: applier.missedFiles,
      missedPathSamples: [...applier.missedPathSamples],
      gitLogFileCount: fileMetrics.totalFileMetadataCount,
      estimatedSavedMs: 0,
    };
    const first = fileMetrics.firstProvider;
    if (first && first.prefetchEndTime > 0 && first.pipelineFlushTime > 0) {
      const overlapEnd = Math.min(first.prefetchEndTime, first.pipelineFlushTime);
      metrics.overlapMs = Math.max(0, overlapEnd - first.prefetchStartTime);
      metrics.overlapRatio =
        metrics.prefetchDurationMs > 0 ? Math.min(1, metrics.overlapMs / metrics.prefetchDurationMs) : 0;
    }
    metrics.estimatedSavedMs = Math.max(0, metrics.overlapMs);

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

    // 6. drain chunkWork
    await chunkPhase.drain();
    const finalChunkMetrics = chunkPhase.getMetrics();
    metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

    // 7. markChunkFinal per ctx
    for (const ctx of contexts.values()) {
      const chunkUnenriched = await readUnenriched(coll, ctx.key, "chunk");
      let chunkStatus: ChunkFinalInput["status"];
      if (filePhase.hasPrefetchFailed(ctx.key) || chunkPhase.hasChunkEnrichmentFailed(ctx.key)) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }
      await markerStore.markChunkFinal(coll, ctx.key, {
        status: chunkStatus,
        durationMs: finalChunkMetrics.totalChunkEnrichmentDurationMs,
        unenrichedChunks: chunkUnenriched,
      });
    }

    // 8. Re-fire stats callback if backfill wrote post-streaming overlays.
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
