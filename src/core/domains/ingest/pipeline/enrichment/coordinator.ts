/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileSignals (fire-and-forget at T=0)
 * 2. Per-batch: apply file signals as chunks arrive
 * 3. Post-flush: provider.buildChunkSignals overlays
 *
 * Supports multiple providers in parallel — each with independent state.
 * Provider-agnostic — works with any EnrichmentProvider implementation.
 */

import { randomUUID } from "node:crypto";
import { relative } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { FileSignalOverlay } from "../../../../contracts/types/provider.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { ChunkPhase } from "./chunk-phase.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { ChunkFinalInput, EnrichmentProvider, ProviderContext } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

interface ProviderState {
  provider: EnrichmentProvider;
  prefetchPromise: Promise<Map<string, FileSignalOverlay>> | null;
  fileMetadata: Map<string, FileSignalOverlay> | null;
  prefetchFailed: boolean;
  effectiveRoot: string | null;
  pendingBatches: PendingBatch[];
  /** applyFileSignals work — drained before file marker is finalized. */
  fileWork: Promise<void>[];
  /** streaming + post-flush chunk enrichment work — drained after file marker. */
  chunkWork: Promise<void>[];
  chunkEnrichmentDurationMs: number;
  ignoreFilter: Ignore | null;
  fileMetadataCount: number;
  prefetchStartTime: number;
  prefetchEndTime: number;
  pipelineFlushTime: number;
  streamingApplies: number;
  flushApplies: number;
  prefetchDurationMs: number;
  /** Relative paths of files already enriched per-batch during streaming. */
  streamingEnrichedFiles: Set<string>;
  /** True if any chunk enrichment work failed; set inside startChunkEnrichment. */
  chunkEnrichmentFailed: boolean;
  /** Set when startChunkEnrichment dispatched at least one provider work. */
  chunkEnrichmentInvoked: boolean;
}

function createProviderState(provider: EnrichmentProvider): ProviderState {
  return {
    provider,
    prefetchPromise: null,
    fileMetadata: null,
    prefetchFailed: false,
    effectiveRoot: null,
    pendingBatches: [],
    fileWork: [],
    chunkWork: [],
    chunkEnrichmentDurationMs: 0,
    ignoreFilter: null,
    fileMetadataCount: 0,
    prefetchStartTime: 0,
    prefetchEndTime: 0,
    pipelineFlushTime: 0,
    streamingApplies: 0,
    flushApplies: 0,
    prefetchDurationMs: 0,
    streamingEnrichedFiles: new Set(),
    chunkEnrichmentFailed: false,
    chunkEnrichmentInvoked: false,
  };
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function filterByIgnore<T>(
  input: Map<string, T>,
  ignoreFilter: Ignore | null,
  root?: string,
): { result: Map<string, T>; filtered: number } {
  if (!ignoreFilter) return { result: input, filtered: 0 };

  let filtered = 0;
  const result = new Map<string, T>();
  for (const [path, value] of input) {
    const relPath = root !== undefined ? relative(root, path) : path;
    if (ignoreFilter.ignores(relPath)) {
      filtered++;
    } else {
      result.set(path, value);
    }
  }
  return { result, filtered };
}

interface AggregatedMetrics {
  totalStreamingApplies: number;
  totalFlushApplies: number;
  totalChunkEnrichmentDurationMs: number;
  maxPrefetchDurationMs: number;
  totalFileMetadataCount: number;
}

function aggregateProviderMetrics(states: Map<string, ProviderState>): AggregatedMetrics {
  let totalStreamingApplies = 0;
  let totalFlushApplies = 0;
  let totalChunkEnrichmentDurationMs = 0;
  let maxPrefetchDurationMs = 0;
  let totalFileMetadataCount = 0;

  for (const state of states.values()) {
    totalStreamingApplies += state.streamingApplies;
    totalFlushApplies += state.flushApplies;
    totalChunkEnrichmentDurationMs += state.chunkEnrichmentDurationMs;
    maxPrefetchDurationMs = Math.max(maxPrefetchDurationMs, state.prefetchDurationMs);
    totalFileMetadataCount += state.fileMetadataCount;
  }

  return {
    totalStreamingApplies,
    totalFlushApplies,
    totalChunkEnrichmentDurationMs,
    maxPrefetchDurationMs,
    totalFileMetadataCount,
  };
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

    this.chunkPhase.init(this.contexts, collectionName ?? "", this.runStartedAt);

    // Write per-provider initial marker: file=in_progress, chunk=pending
    if (collectionName) {
      void this.markerStore.markStart(collectionName, [...this.states.keys()], this.runId, this.runStartedAt);
    }

    for (const state of this.states.values()) {
      state.prefetchStartTime = Date.now();
      state.ignoreFilter = ignoreFilter ?? null;

      // Hold streaming chunk enrichment until file-side prefetch resolves.
      // markReady (success path) or markFailed (catch path) flips this back.
      this.chunkPhase.markPrefetchPending(state.provider.key);

      state.effectiveRoot = state.provider.resolveRoot(absolutePath);
      const root = state.effectiveRoot;

      if (root !== absolutePath) {
        pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
          provider: state.provider.key,
          absolutePath,
          effectiveRoot: root,
        });
      }

      pipelineLog.enrichmentPhase("PREFETCH_START", { provider: state.provider.key, path: root });

      state.prefetchPromise = state.provider
        .buildFileSignals(root, changedPaths ? { paths: changedPaths } : undefined)
        .then((result) => {
          state.prefetchEndTime = Date.now();
          state.fileMetadata = result;
          state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;

          const { result: filteredResult, filtered } = filterByIgnore(result, state.ignoreFilter);
          state.fileMetadata = filteredResult;
          if (filtered > 0) {
            pipelineLog.enrichmentPhase("PREFETCH_FILTERED", {
              provider: state.provider.key,
              filtered,
              remainingFiles: filteredResult.size,
            });
          }

          state.fileMetadataCount = filteredResult.size;

          pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
            provider: state.provider.key,
            filesInLog: result.size,
            durationMs: state.prefetchDurationMs,
          });
          pipelineLog.addStageTime("enrichment_prefetch", state.prefetchDurationMs);

          this.flushPendingBatches(state);
          this.chunkPhase.markReady(state.provider.key);
          return result;
        })
        .catch((error) => {
          state.prefetchFailed = true;
          state.prefetchEndTime = Date.now();
          state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;
          console.error(`[Enrichment:${state.provider.key}] Prefetch failed:`, extractErrorMessage(error));
          pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
            provider: state.provider.key,
            error: extractErrorMessage(error),
            durationMs: state.prefetchDurationMs,
          });
          state.pendingBatches = [];
          this.chunkPhase.markFailed(state.provider.key);

          // Write failed marker for both levels
          if (collectionName) {
            void this.markerStore.markPrefetchFailed(
              collectionName,
              state.provider.key,
              this.runId,
              this.runStartedAt,
              state.prefetchDurationMs,
            );
          }

          return new Map();
        });
    }
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level signals and also triggers streaming chunk-level
   * enrichment so git blame runs overlapped with embedding/upsert of later
   * batches — instead of waiting for a single post-flush catch-up.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    for (const state of this.states.values()) {
      state.pipelineFlushTime = Date.now();

      if (state.prefetchFailed) continue;

      if (state.fileMetadata) {
        const pathBase = state.effectiveRoot || absolutePath;
        const work = this.applier.applyFileSignals(
          collectionName,
          state.provider.key,
          state.fileMetadata,
          pathBase,
          items,
          state.provider.fileSignalTransform,
          this.runStartedAt,
        );
        state.fileWork.push(work);
        state.streamingApplies++;
        pipelineLog.enrichmentPhase("STREAMING_APPLY", {
          provider: state.provider.key,
          chunks: items.length,
        });
      } else {
        state.pendingBatches.push({ collectionName, absolutePath, items });
      }
    }

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
    const prefetchPromises = [...this.states.values()]
      .map(async (s) => s.prefetchPromise)
      .filter((p): p is Promise<Map<string, FileSignalOverlay>> => p !== null);
    if (prefetchPromises.length > 0) {
      await Promise.allSettled(prefetchPromises);
    }

    // 2. Wait for all in-flight FILE work (applyFileSignals). Chunk work runs
    //    independently and is awaited separately so the file marker can be
    //    finalized without waiting for git blame to finish.
    const allFileWork = [...this.states.values()].flatMap((s) => s.fileWork);
    if (allFileWork.length > 0) {
      await Promise.allSettled(allFileWork);
      for (const state of this.states.values()) {
        state.fileWork = [];
      }
    }

    // 3. Backfill file+chunk overlays for paths missed by prefetch.
    if (this.applier.getMissedFileChunks().size > 0) {
      for (const ctx of this.contexts.values()) {
        if (this.states.get(ctx.key)?.prefetchFailed) continue;
        await this.backfiller.runFor(collectionName, ctx, this.runStartedAt);
      }
    }

    // 4. Write FILE marker now — file work is fully drained, chunk work is
    //    still in flight. unenrichedChunks read from storage (not hardcoded)
    //    so the marker stays honest after partial failures or recovery races.
    //    Counters reflect this run's work, not a frozen full-index total.
    for (const state of this.states.values()) {
      const fileUnenriched = await this.countSettledUnenriched(collectionName, state.provider.key, "file");
      await this.markerStore.markFileFinal(collectionName, state.provider.key, {
        status: state.prefetchFailed ? "failed" : "completed",
        durationMs: state.prefetchDurationMs,
        unenrichedChunks: fileUnenriched,
        matchedFiles: this.applier.matchedFiles,
        missedFiles: this.applier.missedFiles,
      });
    }

    // 5. Aggregate metrics across all providers (file-side numbers are final;
    //    chunk durations may grow as chunkWork drains).
    const agg = aggregateProviderMetrics(this.states);
    const chunkMetrics = this.chunkPhase.getMetrics();

    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: agg.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: agg.totalStreamingApplies,
      flushApplies: agg.totalFlushApplies,
      chunkChurnDurationMs: chunkMetrics.totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      matchedFiles: this.applier.matchedFiles,
      missedFiles: this.applier.missedFiles,
      missedPathSamples: [...this.applier.missedPathSamples],
      gitLogFileCount: agg.totalFileMetadataCount,
      estimatedSavedMs: 0,
    };

    // Use the first state for overlap timing calculation (backward compat)
    const firstState = this.states.values().next().value;
    if (firstState && firstState.prefetchEndTime > 0 && firstState.pipelineFlushTime > 0) {
      const overlapEnd = Math.min(firstState.prefetchEndTime, firstState.pipelineFlushTime);
      metrics.overlapMs = Math.max(0, overlapEnd - firstState.prefetchStartTime);
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
      const chunkUnenriched = await this.countSettledUnenriched(collectionName, state.provider.key, "chunk");

      let chunkStatus: ChunkFinalInput["status"];
      if (state.prefetchFailed || this.chunkPhase.hasChunkEnrichmentFailed(state.provider.key)) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }

      await this.markerStore.markChunkFinal(collectionName, state.provider.key, {
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

  // ── Private ─────────────────────────────────────────────────

  private flushPendingBatches(state: ProviderState): void {
    if (state.pendingBatches.length === 0) return;

    const batches = state.pendingBatches;
    state.pendingBatches = [];

    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      provider: state.provider.key,
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });

    for (const batch of batches) {
      if (!state.fileMetadata) continue;
      const pathBase = state.effectiveRoot || batch.absolutePath;
      const work = this.applier.applyFileSignals(
        batch.collectionName,
        state.provider.key,
        state.fileMetadata,
        pathBase,
        batch.items,
        state.provider.fileSignalTransform,
        this.runStartedAt,
      );
      state.fileWork.push(work);
      state.flushApplies++;
    }
  }
}
