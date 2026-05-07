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
import { Semaphore } from "../../../../infra/semaphore.js";
import type { ChunkLookupEntry, EnrichmentMetrics } from "../../../../types.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import { EnrichmentBackfiller } from "./backfiller.js";
import { EnrichmentMarkerStore } from "./marker-store.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { ChunkFinalInput, EnrichmentProvider, ProviderContext } from "./types.js";

/** Max concurrent git-blame operations shared across all providers + streaming calls. */
const CHUNK_ENRICHMENT_CONCURRENCY = 10;

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

  /**
   * Shared concurrency limiter for chunk enrichment (git blame).
   * Bounds total parallelism across all streaming per-batch calls AND the
   * final startChunkEnrichment catch-up, so pipelines can't explode into
   * N*concurrency concurrent git operations.
   */
  private readonly chunkSemaphore = new Semaphore(CHUNK_ENRICHMENT_CONCURRENCY);

  /**
   * Optional callback fired after ALL providers complete chunk enrichment.
   * Receives the collectionName. Only fires if at least one provider succeeded.
   * Errors in the callback are caught and logged — they do not affect enrichment.
   */
  onChunkEnrichmentComplete?: (collectionName: string) => Promise<void>;

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

    // Write per-provider initial marker: file=in_progress, chunk=pending
    if (collectionName) {
      void this.markerStore.markStart(collectionName, [...this.states.keys()], this.runId, this.runStartedAt);
    }

    for (const state of this.states.values()) {
      state.prefetchStartTime = Date.now();
      state.ignoreFilter = ignoreFilter ?? null;

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

        const batchChunkMap = this.extractBatchChunkMap(items, pathBase);
        this.startStreamingChunkEnrichment(state, collectionName, pathBase, batchChunkMap);
      } else {
        state.pendingBatches.push({ collectionName, absolutePath, items });
      }
    }
  }

  /**
   * Start chunk-level enrichment (Phase 2b). Fire-and-forget, tracked internally.
   * Each provider runs independently.
   */
  startChunkEnrichment(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    const providerPromises: Promise<boolean>[] = [];

    for (const state of this.states.values()) {
      if (state.prefetchFailed) continue;

      const root = state.effectiveRoot || absolutePath;
      state.chunkEnrichmentInvoked = true;

      // Filter chunkMap by ignore patterns
      const { result: effectiveChunkMap, filtered } = filterByIgnore(chunkMap, state.ignoreFilter, root);
      if (filtered > 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FILTERED", {
          provider: state.provider.key,
          filtered,
          remaining: effectiveChunkMap.size,
        });
      }

      // Drop files already covered by streaming chunk enrichment (onChunksStored).
      const remainingChunkMap = new Map<string, ChunkLookupEntry[]>();
      for (const [filePath, entries] of effectiveChunkMap) {
        const rel = filePath.startsWith(root) ? filePath.slice(root.length + 1) : filePath;
        if (!state.streamingEnrichedFiles.has(rel)) {
          remainingChunkMap.set(filePath, entries);
        }
      }

      if (remainingChunkMap.size === 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_SKIPPED", {
          provider: state.provider.key,
          reason: "all files enriched via streaming",
          streamingEnrichedFiles: state.streamingEnrichedFiles.size,
        });
        // Marker write deferred to awaitCompletion's chunk-finalization phase
        // so file marker can be written first.
        providerPromises.push(Promise.resolve(true));
        continue;
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: state.provider.key,
        files: remainingChunkMap.size,
        streamingEnrichedFiles: state.streamingEnrichedFiles.size,
      });

      const chunkStart = Date.now();

      // Collect all chunk IDs so applier can stamp enrichedAt on chunks with no commits
      const allChunkIds = new Set<string>();
      for (const entries of remainingChunkMap.values()) {
        for (const entry of entries) allChunkIds.add(entry.chunkId);
      }

      const providerDone = state.provider
        .buildChunkSignals(root, remainingChunkMap, { skipCache: true })
        .then(async (chunkMetadata) => {
          const applied = await this.applier.applyChunkSignals(
            collectionName,
            state.provider.key,
            chunkMetadata,
            this.runStartedAt,
            allChunkIds,
          );
          state.chunkEnrichmentDurationMs += Date.now() - chunkStart;

          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_COMPLETE", {
            provider: state.provider.key,
            overlaysApplied: applied,
            durationMs: state.chunkEnrichmentDurationMs,
          });
          return true;
        })
        .catch((error) => {
          state.chunkEnrichmentDurationMs += Date.now() - chunkStart;
          state.chunkEnrichmentFailed = true;
          console.error(`[Enrichment:${state.provider.key}] Chunk enrichment failed:`, error);
          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FAILED", {
            provider: state.provider.key,
            error: extractErrorMessage(error),
          });
          return false;
        });

      // Track as chunk work so awaitCompletion drains it before finalizing chunk marker.
      state.chunkWork.push(providerDone.then(() => {}));
      providerPromises.push(providerDone);
    }

    // Fire callback after ALL providers complete (if at least one succeeded)
    if (providerPromises.length > 0 && this.onChunkEnrichmentComplete) {
      const callback = this.onChunkEnrichmentComplete;
      void Promise.allSettled(providerPromises).then(async (results) => {
        const anySucceeded = results.some((r) => r.status === "fulfilled" && r.value === true);
        if (!anySucceeded) return;
        try {
          await callback(collectionName);
        } catch (error) {
          console.error("[Enrichment] onChunkEnrichmentComplete callback failed:", error);
        }
      });
    }
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

    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: agg.maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: agg.totalStreamingApplies,
      flushApplies: agg.totalFlushApplies,
      chunkChurnDurationMs: agg.totalChunkEnrichmentDurationMs,
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
    const allChunkWork = [...this.states.values()].flatMap((s) => s.chunkWork);
    if (allChunkWork.length > 0) {
      await Promise.allSettled(allChunkWork);
      for (const state of this.states.values()) {
        state.chunkWork = [];
      }
    }

    for (const state of this.states.values()) {
      const chunkUnenriched = await this.countSettledUnenriched(collectionName, state.provider.key, "chunk");

      let chunkStatus: ChunkFinalInput["status"];
      if (state.prefetchFailed || state.chunkEnrichmentFailed) {
        chunkStatus = "failed";
      } else if (chunkUnenriched > 0) {
        chunkStatus = "degraded";
      } else {
        chunkStatus = "completed";
      }

      await this.markerStore.markChunkFinal(collectionName, state.provider.key, {
        status: chunkStatus,
        durationMs: state.chunkEnrichmentDurationMs,
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

      const batchChunkMap = this.extractBatchChunkMap(batch.items, pathBase);
      this.startStreamingChunkEnrichment(state, batch.collectionName, pathBase, batchChunkMap);
    }
  }

  /**
   * Build a per-batch chunkMap keyed by relative path from pathBase.
   * Matches the shape buildChunkChurnMap expects.
   */
  private extractBatchChunkMap(items: ChunkItem[], pathBase: string): Map<string, ChunkLookupEntry[]> {
    const map = new Map<string, ChunkLookupEntry[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const rel = fp.startsWith(pathBase) ? fp.slice(pathBase.length + 1) : fp;
      const arr = map.get(rel) ?? [];
      arr.push({
        chunkId: item.chunkId,
        startLine: item.chunk.startLine,
        endLine: item.chunk.endLine,
      });
      map.set(rel, arr);
    }
    return map;
  }

  /**
   * Fire-and-forget streaming chunk enrichment for a single batch.
   * Shares this.chunkSemaphore across calls so total git blame parallelism
   * stays bounded even when many batches arrive rapidly. Marks files as
   * streaming-enriched before the async work starts so startChunkEnrichment()
   * can skip them without racing.
   */
  private startStreamingChunkEnrichment(
    state: ProviderState,
    collectionName: string,
    pathBase: string,
    batchChunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    if (state.ignoreFilter) {
      for (const relPath of [...batchChunkMap.keys()]) {
        if (state.ignoreFilter.ignores(relPath)) batchChunkMap.delete(relPath);
      }
    }

    if (batchChunkMap.size === 0) return;

    const root = state.effectiveRoot || pathBase;

    for (const relPath of batchChunkMap.keys()) {
      state.streamingEnrichedFiles.add(relPath);
    }

    const allChunkIds = new Set<string>();
    for (const entries of batchChunkMap.values()) {
      for (const entry of entries) allChunkIds.add(entry.chunkId);
    }

    pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_START", {
      provider: state.provider.key,
      files: batchChunkMap.size,
      chunks: allChunkIds.size,
    });

    const streamStart = Date.now();
    const work = state.provider
      .buildChunkSignals(root, batchChunkMap, {
        concurrencySemaphore: this.chunkSemaphore,
        skipCache: true,
      })
      .then(async (chunkMetadata) => {
        const applied = await this.applier.applyChunkSignals(
          collectionName,
          state.provider.key,
          chunkMetadata,
          this.runStartedAt,
          allChunkIds,
        );
        state.chunkEnrichmentDurationMs += Date.now() - streamStart;
        pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_COMPLETE", {
          provider: state.provider.key,
          files: batchChunkMap.size,
          overlaysApplied: applied,
        });
      })
      .catch((error) => {
        pipelineLog.enrichmentPhase("STREAMING_CHUNK_ENRICHMENT_FAILED", {
          provider: state.provider.key,
          error: extractErrorMessage(error),
        });
      });

    state.chunkWork.push(work);
  }
}
