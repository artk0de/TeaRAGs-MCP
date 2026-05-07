/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileSignals (fire-and-forget at T=0) — owned by FilePhase
 * 2. Per-batch: apply file signals as chunks arrive — owned by FilePhase
 * 3. Streaming + post-flush chunk overlays — owned by ChunkPhase
 *
 * Supports multiple providers in parallel — each with independent state.
 * Provider-agnostic — works with any EnrichmentProvider implementation.
 */

import { randomUUID } from "node:crypto";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase } from "./chunk-phase.js";
import { FilePhase } from "./file-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { ChunkFinalInput, EnrichmentProvider, ProviderContext } from "./types.js";

/**
 * Post-Task-6 ProviderState is reduced to just the provider reference. Kept as
 * its own type so iteration over providers stays explicit; Tasks 7-8 collapse
 * this further.
 */
interface ProviderState {
  provider: EnrichmentProvider;
}

function createProviderState(provider: EnrichmentProvider): ProviderState {
  return { provider };
}

export class EnrichmentCoordinator {
  private readonly states: Map<string, ProviderState>;
  private contexts: Map<string, ProviderContext>;
  private startTime = 0;
  private runId = "";
  private runStartedAt = "";

  // Delegates
  private readonly applier: EnrichmentApplier;
  private readonly markerStore: EnrichmentMarkerStore;
  private readonly backfiller: EnrichmentBackfiller;
  private readonly filePhase: FilePhase;
  private readonly chunkPhase: ChunkPhase;

  /**
   * Optional callback fired after ALL providers complete chunk enrichment.
   * Receives the collectionName. Only fires if at least one provider succeeded.
   * Errors in the callback are caught and logged — they do not affect enrichment.
   * Backed by ChunkPhase.setOnComplete; getter exposes the stored callback for
   * tests and external assertions.
   */
  private _onChunkEnrichmentComplete?: (collectionName: string) => Promise<void>;
  get onChunkEnrichmentComplete(): ((collectionName: string) => Promise<void>) | undefined {
    return this._onChunkEnrichmentComplete;
  }
  set onChunkEnrichmentComplete(cb: ((collectionName: string) => Promise<void>) | undefined) {
    this._onChunkEnrichmentComplete = cb;
    if (cb) this.chunkPhase.setOnComplete(cb);
  }

  /** All provider keys managed by this coordinator. */
  get providerKeys(): string[] {
    return [...this.states.keys()];
  }

  /** @deprecated Use providerKeys instead. Returns the first provider key for backward compat. */
  get providerKey(): string {
    const first = this.states.keys().next();
    return first.done ? "" : first.value;
  }

  constructor(
    private readonly qdrant: QdrantManager,
    providers: EnrichmentProvider | EnrichmentProvider[],
    private readonly recovery?: EnrichmentRecovery,
  ) {
    this.applier = new EnrichmentApplier(qdrant);
    this.markerStore = new EnrichmentMarkerStore(qdrant);
    this.backfiller = new EnrichmentBackfiller(this.applier, qdrant);
    this.chunkPhase = new ChunkPhase(this.applier);
    this.filePhase = new FilePhase(this.applier, this.markerStore);
    this.filePhase.bindChunkPhase(this.chunkPhase);
    const list = Array.isArray(providers) ? providers : [providers];
    this.states = new Map(list.map((p) => [p.key, createProviderState(p)]));
    // Seed contexts with provider entries so runRecovery works when invoked
    // before prefetch (e.g. recovery-only paths). prefetch() overwrites with
    // resolved effectiveRoot + ignoreFilter for the actual run.
    this.contexts = new Map(
      list.map((provider) => [provider.key, { key: provider.key, provider, effectiveRoot: null, ignoreFilter: null }]),
    );
  }

  /**
   * Run recovery + migration before the main enrichment pipeline.
   * Migration is one-time and idempotent. Recovery re-enriches chunks missing enrichedAt.
   * No-op when recovery was not provided at construction time.
   */
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;
    await this.recovery.recoverAll(collectionName, absolutePath, this.contexts, this.markerStore);
  }

  /**
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   * All providers prefetch in parallel.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
    this.startTime = Date.now();
    this.runId = randomUUID().slice(0, 8);
    this.runStartedAt = new Date().toISOString();

    this.contexts = new Map(
      [...this.states.values()].map((state) => {
        const effectiveRoot = state.provider.resolveRoot(absolutePath);
        if (effectiveRoot !== absolutePath) {
          pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
            provider: state.provider.key,
            absolutePath,
            effectiveRoot,
          });
        }
        return [
          state.provider.key,
          {
            key: state.provider.key,
            provider: state.provider,
            effectiveRoot,
            ignoreFilter: ignoreFilter ?? null,
          },
        ];
      }),
    );

    this.filePhase.init(this.contexts, collectionName ?? "", this.runId, this.runStartedAt);
    this.chunkPhase.init(this.contexts, collectionName ?? "", this.runStartedAt);

    // Write per-provider initial marker: file=in_progress, chunk=pending
    if (collectionName) {
      void this.markerStore.markStart(collectionName, [...this.states.keys()], this.runId, this.runStartedAt);
    }

    this.filePhase.startPrefetch(changedPaths);
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level signals and also triggers streaming chunk-level
   * enrichment so git blame runs overlapped with embedding/upsert of later
   * batches — instead of waiting for a single post-flush catch-up.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    this.filePhase.onBatch(collectionName, absolutePath, items);
    this.chunkPhase.onBatch(collectionName, absolutePath, items);
  }

  /**
   * Start chunk-level enrichment (Phase 2b). Fire-and-forget, tracked internally.
   * Each provider runs independently.
   */
  startChunkEnrichment(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    this.chunkPhase.enrichRemaining(collectionName, absolutePath, chunkMap);
  }

  /**
   * Wait for all in-flight enrichment work to complete across all providers.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    if (this.states.size === 0) {
      return {
        prefetchDurationMs: 0,
        overlapMs: 0,
        overlapRatio: 0,
        streamingApplies: 0,
        flushApplies: 0,
        chunkChurnDurationMs: 0,
        totalDurationMs: 0,
        matchedFiles: 0,
        missedFiles: 0,
        missedPathSamples: [],
        gitLogFileCount: 0,
        estimatedSavedMs: 0,
      };
    }

    // 1. Wait for all prefetch promises
    await this.filePhase.awaitPrefetch();

    // 2. Wait for all in-flight FILE work (applyFileSignals). Chunk work runs
    //    independently and is awaited separately so the file marker can be
    //    finalized without waiting for git blame to finish.
    await this.filePhase.drain();

    // 3. Backfill file+chunk overlays for paths missed by prefetch.
    if (this.applier.getMissedFileChunks().size > 0) {
      for (const ctx of this.contexts.values()) {
        if (this.filePhase.hasPrefetchFailed(ctx.key)) continue;
        await this.backfiller.runFor(collectionName, ctx, this.runStartedAt);
      }
    }

    // 4. Write FILE marker now — file work is fully drained, chunk work is
    //    still in flight. unenrichedChunks read from storage (not hardcoded)
    //    so the marker stays honest after partial failures or recovery races.
    //    Counters reflect this run's work, not a frozen full-index total.
    for (const state of this.states.values()) {
      const providerKey = state.provider.key;
      const fileUnenriched = await this.countSettledUnenriched(collectionName, providerKey, "file");
      const prefetchFailed = this.filePhase.hasPrefetchFailed(providerKey);
      await this.markerStore.markFileFinal(collectionName, providerKey, {
        status: prefetchFailed ? "failed" : "completed",
        durationMs: this.filePhase.getPrefetchDurationMs(providerKey),
        unenrichedChunks: fileUnenriched,
        matchedFiles: this.applier.matchedFiles,
        missedFiles: this.applier.missedFiles,
      });
    }

    // 5. Aggregate metrics across all providers (file-side numbers are final;
    //    chunk durations may grow as chunkWork drains).
    const fileMetrics = this.filePhase.getMetrics();
    const chunkMetrics = this.chunkPhase.getMetrics();

    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: fileMetrics.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: fileMetrics.totalStreamingApplies,
      flushApplies: fileMetrics.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      matchedFiles: this.applier.matchedFiles,
      missedFiles: this.applier.missedFiles,
      missedPathSamples: [...this.applier.missedPathSamples],
      gitLogFileCount: fileMetrics.totalFileMetadataCount,
      estimatedSavedMs: 0,
    };

    // Use the first provider's timings for overlap calculation (backward compat).
    const first = fileMetrics.firstProvider;
    if (first && first.prefetchEndTime > 0 && first.pipelineFlushTime > 0) {
      const overlapEnd = Math.min(first.prefetchEndTime, first.pipelineFlushTime);
      metrics.overlapMs = Math.max(0, overlapEnd - first.prefetchStartTime);
      metrics.overlapRatio =
        metrics.prefetchDurationMs > 0 ? Math.min(1, metrics.overlapMs / metrics.prefetchDurationMs) : 0;
    }
    metrics.estimatedSavedMs = Math.max(0, metrics.overlapMs);

    // 6. Wait for chunk work (streaming + post-flush) and finalize chunk marker.
    //    Chunk status writes inside startChunkEnrichment may already mark
    //    chunk=completed; here we sync unenrichedChunks with storage as the
    //    last word, in case streaming completed before backfill or recovery raced.
    await this.chunkPhase.drain();

    const finalChunkMetrics = this.chunkPhase.getMetrics();
    metrics.chunkChurnDurationMs = finalChunkMetrics.totalChunkEnrichmentDurationMs;

    for (const state of this.states.values()) {
      const providerKey = state.provider.key;
      const chunkUnenriched = await this.countSettledUnenriched(collectionName, providerKey, "chunk");

      let chunkStatus: ChunkFinalInput["status"];
      if (this.filePhase.hasPrefetchFailed(providerKey) || this.chunkPhase.hasChunkEnrichmentFailed(providerKey)) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }

      await this.markerStore.markChunkFinal(collectionName, providerKey, {
        status: chunkStatus,
        durationMs: finalChunkMetrics.totalChunkEnrichmentDurationMs,
        unenrichedChunks: chunkUnenriched,
      });
    }

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });

    return metrics;
  }

  /**
   * Count chunks missing enrichedAt for the marker. Re-polls once after a brief
   * grace period when the first count is non-zero — `batchSetPayload` writes
   * during enrichment use `wait: false`, so Qdrant's payload-filter index can
   * lag the actual point payloads by a few hundred milliseconds. The first
   * snapshot may report stale "unenriched" chunks that have already been
   * written but not yet indexed; the re-poll catches up to ground truth and
   * keeps the persisted marker honest.
   */
  private async countSettledUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<number> {
    if (!this.recovery) return 0;
    const first = await this.recovery.countUnenriched(collectionName, providerKey, level).catch(() => 0);
    if (first === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await this.recovery.countUnenriched(collectionName, providerKey, level).catch(() => first);
  }
}
