/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases per provider:
 * 1. Prefetch: provider.buildFileMetadata (fire-and-forget at T=0)
 * 2. Per-batch: apply file metadata as chunks arrive
 * 3. Post-flush: provider.buildChunkMetadata overlays
 *
 * Supports multiple providers in parallel — each with independent state.
 * Provider-agnostic — works with any EnrichmentProvider implementation.
 */

import { relative } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentInfo, EnrichmentMetrics } from "../../../types.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../infra/debug-logger.js";
import type { ChunkItem } from "../types.js";
import { EnrichmentApplier } from "./applier.js";
import type { EnrichmentProvider } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

interface ProviderState {
  provider: EnrichmentProvider;
  prefetchPromise: Promise<Map<string, Record<string, unknown>>> | null;
  fileMetadata: Map<string, Record<string, unknown>> | null;
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

export class EnrichmentCoordinator {
  private readonly states: Map<string, ProviderState>;
  private startTime = 0;

  // Delegates
  private readonly applier: EnrichmentApplier;

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
  ) {
    this.applier = new EnrichmentApplier(qdrant);
    const list = Array.isArray(providers) ? providers : [providers];
    this.states = new Map(list.map((p) => [p.key, createProviderState(p)]));
  }

  /**
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   * All providers prefetch in parallel.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
    this.startTime = Date.now();

    // Set enrichment marker to "in_progress" (once for all providers)
    if (collectionName) {
      this.updateEnrichmentMarker(collectionName, {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      }).catch(() => {});
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
        .buildFileMetadata(root)
        .then((result) => {
          state.prefetchEndTime = Date.now();
          state.fileMetadata = result;
          state.prefetchDurationMs = state.prefetchEndTime - state.prefetchStartTime;

          // Filter by ignore patterns
          if (state.ignoreFilter) {
            let filtered = 0;
            for (const [path] of result) {
              if (state.ignoreFilter.ignores(path)) {
                result.delete(path);
                filtered++;
              }
            }
            if (filtered > 0) {
              pipelineLog.enrichmentPhase("PREFETCH_FILTERED", {
                provider: state.provider.key,
                filtered,
                remainingFiles: result.size,
              });
            }
          }

          state.fileMetadataCount = result.size;

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
          console.error(
            `[Enrichment:${state.provider.key}] Prefetch failed:`,
            error instanceof Error ? error.message : error,
          );
          pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
            provider: state.provider.key,
            error: error instanceof Error ? error.message : String(error),
            durationMs: state.prefetchDurationMs,
          });
          state.pendingBatches = [];
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
        const work = this.applier.applyFileMetadata(
          collectionName,
          state.provider.key,
          state.fileMetadata,
          pathBase,
          items,
          state.provider.fileTransform,
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
    for (const state of this.states.values()) {
      if (state.prefetchFailed) continue;

      const root = state.effectiveRoot || absolutePath;

      // Filter chunkMap by ignore patterns
      let effectiveChunkMap = chunkMap;
      if (state.ignoreFilter) {
        effectiveChunkMap = new Map();
        let filtered = 0;
        for (const [filePath, entries] of chunkMap) {
          const relPath = relative(root, filePath);
          if (state.ignoreFilter.ignores(relPath)) {
            filtered++;
          } else {
            effectiveChunkMap.set(filePath, entries);
          }
        }
        if (filtered > 0) {
          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FILTERED", {
            provider: state.provider.key,
            filtered,
            remaining: effectiveChunkMap.size,
          });
        }
      }

      pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
        provider: state.provider.key,
        files: effectiveChunkMap.size,
      });

      const chunkStart = Date.now();

      state.provider
        .buildChunkMetadata(root, effectiveChunkMap)
        .then(async (chunkMetadata) => {
          const applied = await this.applier.applyChunkMetadata(collectionName, state.provider.key, chunkMetadata);
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;

          // Write chunk enrichment status to Qdrant
          try {
            await this.qdrant.setPayload(
              collectionName,
              {
                chunkEnrichment: {
                  status: "completed",
                  provider: state.provider.key,
                  overlaysApplied: applied,
                  durationMs: state.chunkEnrichmentDurationMs,
                },
              },
              { points: [INDEXING_METADATA_ID] },
            );
          } catch {
            // non-fatal
          }

          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_COMPLETE", {
            provider: state.provider.key,
            overlaysApplied: applied,
            durationMs: state.chunkEnrichmentDurationMs,
          });
        })
        .catch((error) => {
          state.chunkEnrichmentDurationMs = Date.now() - chunkStart;
          console.error(`[Enrichment:${state.provider.key}] Chunk enrichment failed:`, error);
          pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FAILED", {
            provider: state.provider.key,
            error: error instanceof Error ? error.message : String(error),
          });
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
      .filter((p): p is Promise<Map<string, Record<string, unknown>>> => p !== null);
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
    let totalStreamingApplies = 0;
    let totalFlushApplies = 0;
    let totalChunkEnrichmentDurationMs = 0;
    let maxPrefetchDurationMs = 0;
    let totalFileMetadataCount = 0;

    for (const state of this.states.values()) {
      totalStreamingApplies += state.streamingApplies;
      totalFlushApplies += state.flushApplies;
      totalChunkEnrichmentDurationMs += state.chunkEnrichmentDurationMs;
      maxPrefetchDurationMs = Math.max(maxPrefetchDurationMs, state.prefetchDurationMs);
      totalFileMetadataCount += state.fileMetadataCount;
    }

    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: maxPrefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: totalStreamingApplies,
      flushApplies: totalFlushApplies,
      chunkChurnDurationMs: totalChunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      matchedFiles: this.applier.matchedFiles,
      missedFiles: this.applier.missedFiles,
      missedPathSamples: [...this.applier.missedPathSamples],
      gitLogFileCount: totalFileMetadataCount,
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

    // 6. Update enrichment marker (once for all providers)
    await this.updateEnrichmentMarker(collectionName, {
      status: "completed",
      completedAt: new Date().toISOString(),
      durationMs: metrics.totalDurationMs,
      matchedFiles: metrics.matchedFiles,
      missedFiles: metrics.missedFiles,
      gitLogFileCount: totalFileMetadataCount,
    });

    pipelineLog.enrichmentPhase("ALL_COMPLETE", { ...metrics });

    return metrics;
  }

  /**
   * Update enrichment progress marker in Qdrant.
   */
  async updateEnrichmentMarker(collectionName: string, info: Partial<EnrichmentInfo>): Promise<void> {
    try {
      const enrichment: Record<string, unknown> = { ...info };
      if (info.totalFiles && info.processedFiles !== undefined) {
        enrichment.percentage = Math.round((info.processedFiles / info.totalFiles) * 100);
      }
      await this.qdrant.setPayload(collectionName, { enrichment }, { points: [INDEXING_METADATA_ID] });
    } catch (error) {
      if (process.env.DEBUG) {
        console.error("[Enrichment] Failed to update marker:", error);
      }
    }
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
      const work = this.applier.applyFileMetadata(
        batch.collectionName,
        state.provider.key,
        state.fileMetadata,
        pathBase,
        batch.items,
        state.provider.fileTransform,
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
    let backfillData: Map<string, Record<string, unknown>>;
    try {
      const root = state.effectiveRoot;
      if (!root) return;
      backfillData = await state.provider.buildFileMetadata(root, { paths: missedPaths });
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
        provider: state.provider.key,
        error: error instanceof Error ? error.message : String(error),
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
      const finalData = state.provider.fileTransform ? state.provider.fileTransform(data, maxEndLine) : data;
      const payload = { [state.provider.key]: { file: finalData } };

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
          if (process.env.DEBUG) {
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
