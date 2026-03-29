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
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import { isDebug } from "../infra/runtime.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import type { EnrichmentRecovery } from "./recovery.js";
import type { ChunkEnrichmentMarker, EnrichmentProvider, FileEnrichmentMarker } from "./types.js";

/** Deep-partial update for a provider marker — allows partial file/chunk sub-objects. */
type ProviderMarkerUpdate = {
  runId?: string;
  file?: Partial<FileEnrichmentMarker>;
  chunk?: Partial<ChunkEnrichmentMarker>;
};

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
  inFlightWork: Promise<void>[];
  chunkEnrichmentDurationMs: number;
  ignoreFilter: Ignore | null;
  fileMetadataCount: number;
  prefetchStartTime: number;
  prefetchEndTime: number;
  pipelineFlushTime: number;
  streamingApplies: number;
  flushApplies: number;
  prefetchDurationMs: number;
}

function createProviderState(provider: EnrichmentProvider): ProviderState {
  return {
    provider,
    prefetchPromise: null,
    fileMetadata: null,
    prefetchFailed: false,
    effectiveRoot: null,
    pendingBatches: [],
    inFlightWork: [],
    chunkEnrichmentDurationMs: 0,
    ignoreFilter: null,
    fileMetadataCount: 0,
    prefetchStartTime: 0,
    prefetchEndTime: 0,
    pipelineFlushTime: 0,
    streamingApplies: 0,
    flushApplies: 0,
    prefetchDurationMs: 0,
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
  private startTime = 0;
  private scopedPrefetch = false;
  private runId = "";
  private runStartedAt = "";

  // Delegates
  private readonly applier: EnrichmentApplier;

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
    const list = Array.isArray(providers) ? providers : [providers];
    this.states = new Map(list.map((p) => [p.key, createProviderState(p)]));
  }

  /**
   * Run recovery + migration before the main enrichment pipeline.
   * Migration is one-time and idempotent. Recovery re-enriches chunks missing enrichedAt.
   * No-op when recovery was not provided at construction time.
   */
  async runRecovery(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.recovery) return;

    const enrichedAt = new Date().toISOString();

    for (const state of this.states.values()) {
      const { provider } = state;

      await this.recovery.recoverFileLevel(collectionName, absolutePath, provider, enrichedAt);
      await this.recovery.recoverChunkLevel(collectionName, absolutePath, provider, enrichedAt);

      // Update marker with post-recovery counts
      const fileCount = await this.recovery.countUnenriched(collectionName, provider.key, "file");
      const chunkCount = await this.recovery.countUnenriched(collectionName, provider.key, "chunk");

      await this.updateEnrichmentMarker(collectionName, {
        [provider.key]: {
          file: {
            status: fileCount === 0 ? "completed" : "failed",
            unenrichedChunks: fileCount,
          },
          chunk: {
            status: chunkCount === 0 ? "completed" : chunkCount > 0 ? "degraded" : "completed",
            unenrichedChunks: chunkCount,
          },
        },
      });
    }
  }

  /**
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   * All providers prefetch in parallel.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore, changedPaths?: string[]): void {
    this.startTime = Date.now();
    this.scopedPrefetch = changedPaths !== undefined;
    this.runId = randomUUID().slice(0, 8);
    this.runStartedAt = new Date().toISOString();

    // Write per-provider initial marker: file=in_progress, chunk=pending
    if (collectionName) {
      const initialMarker: Record<string, ProviderMarkerUpdate> = {};
      for (const state of this.states.values()) {
        initialMarker[state.provider.key] = {
          runId: this.runId,
          file: { status: "in_progress", startedAt: this.runStartedAt, unenrichedChunks: 0 },
          chunk: { status: "pending", unenrichedChunks: 0 },
        };
      }
      this.updateEnrichmentMarker(collectionName, initialMarker).catch(() => {});
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
            const now = new Date().toISOString();
            this.updateEnrichmentMarker(collectionName, {
              [state.provider.key]: {
                runId: this.runId,
                file: {
                  status: "failed",
                  startedAt: this.runStartedAt,
                  completedAt: now,
                  durationMs: state.prefetchDurationMs,
                  unenrichedChunks: 0,
                },
                chunk: { status: "failed", unenrichedChunks: 0 },
              },
            }).catch(() => {});
          }

          return new Map();
        });
    }
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
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
        state.inFlightWork.push(work);
        state.streamingApplies++;
        pipelineLog.enrichmentPhase("STREAMING_APPLY", {
          provider: state.provider.key,
          chunks: items.length,
        });
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

      // Filter chunkMap by ignore patterns
      const { result: effectiveChunkMap, filtered } = filterByIgnore(chunkMap, state.ignoreFilter, root);
      if (filtered > 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FILTERED", {
          provider: state.provider.key,
          filtered,
          remaining: effectiveChunkMap.size,
        });
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: state.provider.key,
        files: effectiveChunkMap.size,
      });

      const chunkStart = Date.now();

      // Collect all chunk IDs so applier can stamp enrichedAt on chunks with no commits
      const allChunkIds = new Set<string>();
      for (const entries of effectiveChunkMap.values()) {
        for (const entry of entries) allChunkIds.add(entry.chunkId);
      }

      const providerDone = state.provider
        .buildChunkSignals(root, effectiveChunkMap)
        .then(async (chunkMetadata) => {
          const applied = await this.applier.applyChunkSignals(
            collectionName,
            state.provider.key,
            chunkMetadata,
            this.runStartedAt,
            allChunkIds,
          );
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;

          // Write per-provider chunk marker
          await this.updateEnrichmentMarker(collectionName, {
            [state.provider.key]: {
              chunk: {
                status: "completed",
                completedAt: new Date().toISOString(),
                durationMs: state.chunkEnrichmentDurationMs,
                unenrichedChunks: 0,
              },
            },
          });

          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_COMPLETE", {
            provider: state.provider.key,
            overlaysApplied: applied,
            durationMs: state.chunkEnrichmentDurationMs,
          });
          return true;
        })
        .catch((error) => {
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;
          console.error(`[Enrichment:${state.provider.key}] Chunk enrichment failed:`, error);
          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FAILED", {
            provider: state.provider.key,
            error: extractErrorMessage(error),
          });

          // Write per-provider chunk failure marker
          this.updateEnrichmentMarker(collectionName, {
            [state.provider.key]: {
              chunk: {
                status: "failed",
                completedAt: new Date().toISOString(),
                durationMs: state.chunkEnrichmentDurationMs,
                unenrichedChunks: 0,
              },
            },
          }).catch(() => {});

          return false;
        });

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

    // 2. Wait for all in-flight streaming applies across all states
    const allInFlight = [...this.states.values()].flatMap((s) => s.inFlightWork);
    if (allInFlight.length > 0) {
      await Promise.allSettled(allInFlight);
      for (const state of this.states.values()) {
        state.inFlightWork = [];
      }
    }

    // 3. Backfill file-level metadata for missed files (per provider)
    if (this.applier.missedFileChunks.size > 0) {
      for (const state of this.states.values()) {
        if (state.effectiveRoot && !state.prefetchFailed) {
          await this.backfillMissedFiles(collectionName, state);
        }
      }
    }

    // 4. Chunk enrichment runs in background — do NOT await here.

    // 5. Aggregate metrics across all providers
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

    // 6. Update per-provider file-level markers with final status
    // Scoped prefetch (incremental reindex): only update status/timing, not coverage stats.
    // Coverage stats (matchedFiles, missedFiles) reflect only changed files
    // and would overwrite the accurate full-index values from the previous run.
    for (const state of this.states.values()) {
      const fileMarker: Partial<FileEnrichmentMarker> = {
        status: state.prefetchFailed ? "failed" : "completed",
        completedAt: new Date().toISOString(),
        durationMs: state.prefetchDurationMs,
        unenrichedChunks: 0,
      };
      if (!this.scopedPrefetch) {
        fileMarker.matchedFiles = this.applier.matchedFiles;
        fileMarker.missedFiles = this.applier.missedFiles;
      }
      await this.updateEnrichmentMarker(collectionName, {
        [state.provider.key]: { file: fileMarker },
      });
    }

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });

    return metrics;
  }

  /**
   * Update enrichment progress marker in Qdrant.
   * Deep-merges per-provider markers, preserving file/chunk fields not in the update.
   */
  async updateEnrichmentMarker(collectionName: string, markerMap: Record<string, ProviderMarkerUpdate>): Promise<void> {
    try {
      const existing = await this.readExistingMarker(collectionName);
      const enrichment: Record<string, unknown> = existing ? { ...existing } : {};

      for (const [providerKey, update] of Object.entries(markerMap)) {
        const prev = (enrichment[providerKey] as Record<string, unknown>) ?? {};
        const merged: Record<string, unknown> = { ...prev };

        if (update.runId !== undefined) merged.runId = update.runId;

        if (update.file) {
          merged.file = { ...(prev.file as Record<string, unknown> | undefined), ...update.file };
        }
        if (update.chunk) {
          merged.chunk = { ...(prev.chunk as Record<string, unknown> | undefined), ...update.chunk };
        }

        enrichment[providerKey] = merged;
      }

      await this.qdrant.setPayload(collectionName, { enrichment }, { points: [INDEXING_METADATA_ID] });
    } catch (error) {
      if (isDebug()) {
        console.error("[Enrichment] Failed to update marker:", error);
      }
    }
  }

  private async readExistingMarker(collectionName: string): Promise<Record<string, unknown> | null> {
    try {
      const point = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
      if (point?.payload && typeof point.payload.enrichment === "object" && point.payload.enrichment !== null) {
        return point.payload.enrichment as Record<string, unknown>;
      }
    } catch {
      // ignore — marker may not exist yet
    }
    return null;
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
      state.inFlightWork.push(work);
      state.flushApplies++;
    }
  }

  private async backfillMissedFiles(collectionName: string, state: ProviderState): Promise<void> {
    const missedPaths = Array.from(this.applier.missedFileChunks.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", {
      provider: state.provider.key,
      missedFiles: missedPaths.length,
    });

    const backfillStart = Date.now();
    let backfillData: Map<string, FileSignalOverlay>;
    try {
      const root = state.effectiveRoot;
      if (!root) return;
      backfillData = await state.provider.buildFileSignals(root, { paths: missedPaths });
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
        provider: state.provider.key,
        error: extractErrorMessage(error),
      });
      return;
    }

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];
    let backfilledFiles = 0;

    for (const [relPath, chunks] of this.applier.missedFileChunks) {
      const data = backfillData.get(relPath);
      if (!data) continue;

      const maxEndLine = chunks.reduce((max, c) => Math.max(max, c.endLine), 0);
      const finalData = state.provider.fileSignalTransform
        ? state.provider.fileSignalTransform(data, maxEndLine)
        : data;
      const fileData = this.runStartedAt
        ? { ...(finalData as Record<string, unknown>), enrichedAt: this.runStartedAt }
        : (finalData as Record<string, unknown>);
      const payload = { [state.provider.key]: { file: fileData } };

      for (const chunk of chunks) {
        operations.push({ payload, points: [chunk.chunkId] });
      }
      backfilledFiles++;
    }

    if (operations.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < operations.length; i += BATCH_SIZE) {
        const batch = operations.slice(i, i + BATCH_SIZE);
        try {
          await this.qdrant.batchSetPayload(collectionName, batch);
        } catch (error) {
          if (isDebug()) {
            console.error(`[Enrichment:${state.provider.key}] backfill batch failed:`, error);
          }
        }
      }
    }

    const backfillDuration = Date.now() - backfillStart;
    this.applier.matchedFiles += backfilledFiles;
    this.applier.missedFiles -= backfilledFiles;

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      provider: state.provider.key,
      missedFiles: missedPaths.length,
      backfilledFiles,
      backfilledChunks: operations.length,
      stillMissed: missedPaths.length - backfilledFiles,
      durationMs: backfillDuration,
    });
  }
}
