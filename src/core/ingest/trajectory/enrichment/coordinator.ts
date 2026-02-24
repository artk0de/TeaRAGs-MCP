/**
 * EnrichmentCoordinator — generic timing orchestrator for enrichment providers.
 *
 * Coordinates three phases:
 * 1. Prefetch: provider.buildFileMetadata (fire-and-forget at T=0)
 * 2. Per-batch: apply file metadata as chunks arrive
 * 3. Post-flush: provider.buildChunkMetadata overlays
 *
 * Provider-agnostic — works with any EnrichmentProvider implementation.
 * Replaces the git-specific EnrichmentModule.
 */

import { relative } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentInfo, EnrichmentMetrics } from "../../../types.js";
import { INDEXING_METADATA_ID } from "../../constants.js";
import { pipelineLog } from "../../pipeline/infra/debug-logger.js";
import type { ChunkItem } from "../../pipeline/types.js";
import { EnrichmentApplier } from "./applier.js";
import type { EnrichmentProvider } from "./types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

export class EnrichmentCoordinator {
  // File metadata state
  private prefetchPromise: Promise<Map<string, Record<string, unknown>>> | null = null;
  private fileMetadata: Map<string, Record<string, unknown>> | null = null;
  private prefetchFailed = false;
  private effectiveRoot: string | null = null;

  // Pending queue (batches waiting for prefetch)
  private pendingBatches: PendingBatch[] = [];

  // In-flight work tracking
  private inFlightWork: Promise<void>[] = [];
  private chunkEnrichmentDurationMs = 0;

  // Ignore filter
  private ignoreFilter: Ignore | null = null;
  private fileMetadataCount = 0;

  // Delegates
  private readonly applier: EnrichmentApplier;

  // Timing metrics
  private startTime = 0;
  private prefetchStartTime = 0;
  private prefetchEndTime = 0;
  private pipelineFlushTime = 0;
  private streamingApplies = 0;
  private flushApplies = 0;
  private prefetchDurationMs = 0;

  get providerKey(): string {
    return this.provider.key;
  }

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly provider: EnrichmentProvider,
  ) {
    this.applier = new EnrichmentApplier(qdrant);
  }

  /**
   * Start file-level metadata prefetch at T=0. Non-blocking.
   * Call before pipeline.start() to maximize overlap.
   */
  prefetch(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
    this.startTime = Date.now();
    this.prefetchStartTime = Date.now();
    this.ignoreFilter = ignoreFilter ?? null;

    // Set enrichment marker to "in_progress"
    if (collectionName) {
      this.updateEnrichmentMarker(collectionName, {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      }).catch(() => {});
    }

    this.effectiveRoot = this.provider.resolveRoot(absolutePath);
    const root = this.effectiveRoot;

    if (root !== absolutePath) {
      pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", { absolutePath, effectiveRoot: root });
    }

    pipelineLog.enrichmentPhase("PREFETCH_START", { path: root });

    this.prefetchPromise = this.provider
      .buildFileMetadata(root)
      .then((result) => {
        this.prefetchEndTime = Date.now();
        this.fileMetadata = result;
        this.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;

        // Filter by ignore patterns
        if (this.ignoreFilter) {
          let filtered = 0;
          for (const [path] of result) {
            if (this.ignoreFilter.ignores(path)) {
              result.delete(path);
              filtered++;
            }
          }
          if (filtered > 0) {
            pipelineLog.enrichmentPhase("PREFETCH_FILTERED", { filtered, remainingFiles: result.size });
          }
        }

        this.fileMetadataCount = result.size;

        pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
          filesInLog: result.size,
          durationMs: this.prefetchDurationMs,
        });
        pipelineLog.addStageTime("gitLog", this.prefetchDurationMs);

        this.flushPendingBatches();
        return result;
      })
      .catch((error) => {
        this.prefetchFailed = true;
        this.prefetchEndTime = Date.now();
        this.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;
        console.error("[Enrichment] Prefetch failed:", error instanceof Error ? error.message : error);
        pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
          error: error instanceof Error ? error.message : String(error),
          durationMs: this.prefetchDurationMs,
        });
        this.pendingBatches = [];
        return new Map();
      });
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   */
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
    this.pipelineFlushTime = Date.now();

    if (this.prefetchFailed) return;

    if (this.fileMetadata) {
      const pathBase = this.effectiveRoot || absolutePath;
      const work = this.applier.applyFileMetadata(
        collectionName,
        this.provider.key,
        this.fileMetadata,
        pathBase,
        items,
        this.provider.fileTransform,
      );
      this.inFlightWork.push(work);
      this.streamingApplies++;
      pipelineLog.enrichmentPhase("STREAMING_APPLY", { chunks: items.length });
    } else {
      this.pendingBatches.push({ collectionName, absolutePath, items });
    }
  }

  /**
   * Start chunk-level enrichment (Phase 2b). Fire-and-forget, tracked internally.
   */
  startChunkEnrichment(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    if (this.prefetchFailed) return;

    const root = this.effectiveRoot || absolutePath;

    // Filter chunkMap by ignore patterns
    let effectiveChunkMap = chunkMap;
    if (this.ignoreFilter) {
      effectiveChunkMap = new Map();
      let filtered = 0;
      for (const [filePath, entries] of chunkMap) {
        const relPath = relative(root, filePath);
        if (this.ignoreFilter.ignores(relPath)) {
          filtered++;
        } else {
          effectiveChunkMap.set(filePath, entries);
        }
      }
      if (filtered > 0) {
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FILTERED", {
          filtered,
          remaining: effectiveChunkMap.size,
        });
      }
    }

    pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_START", {
      files: effectiveChunkMap.size,
    });

    const chunkStart = Date.now();

    this.provider
      .buildChunkMetadata(root, effectiveChunkMap)
      .then(async (chunkMetadata) => {
        const applied = await this.applier.applyChunkMetadata(collectionName, this.provider.key, chunkMetadata);
        this.chunkEnrichmentDurationMs = Date.now() - chunkStart;

        // Write chunk enrichment status to Qdrant
        try {
          await this.qdrant.setPayload(
            collectionName,
            {
              chunkEnrichment: {
                status: "completed",
                overlaysApplied: applied,
                durationMs: this.chunkEnrichmentDurationMs,
              },
            },
            { points: [INDEXING_METADATA_ID] },
          );
        } catch {
          // non-fatal
        }

        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_COMPLETE", {
          overlaysApplied: applied,
          durationMs: this.chunkEnrichmentDurationMs,
        });
      })
      .catch((error) => {
        this.chunkEnrichmentDurationMs = Date.now() - chunkStart;
        console.error("[Enrichment] Chunk enrichment failed:", error);
        pipelineLog.enrichmentPhase("CHUNK_ENRICHMENT_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  /**
   * Wait for all in-flight enrichment work to complete.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    // 1. Wait for prefetch
    if (this.prefetchPromise) {
      await this.prefetchPromise.catch(() => {});
    }

    // 2. Wait for all streaming applies
    if (this.inFlightWork.length > 0) {
      await Promise.allSettled(this.inFlightWork);
      this.inFlightWork = [];
    }

    // 3. Backfill file-level metadata for missed files
    if (this.applier.missedFileChunks.size > 0 && this.effectiveRoot) {
      await this.backfillMissedFiles(collectionName);
    }

    // 4. Chunk enrichment runs in background — do NOT await here.

    // Compute overlap metrics
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: this.prefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: this.streamingApplies,
      flushApplies: this.flushApplies,
      chunkChurnDurationMs: this.chunkEnrichmentDurationMs,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      matchedFiles: this.applier.matchedFiles,
      missedFiles: this.applier.missedFiles,
      missedPathSamples: [...this.applier.missedPathSamples],
      gitLogFileCount: this.fileMetadataCount,
      estimatedSavedMs: 0,
    };

    if (this.prefetchEndTime > 0 && this.pipelineFlushTime > 0) {
      const overlapEnd = Math.min(this.prefetchEndTime, this.pipelineFlushTime);
      metrics.overlapMs = Math.max(0, overlapEnd - this.prefetchStartTime);
      metrics.overlapRatio =
        metrics.prefetchDurationMs > 0 ? Math.min(1, metrics.overlapMs / metrics.prefetchDurationMs) : 0;
    }
    metrics.estimatedSavedMs = Math.max(0, metrics.overlapMs);

    // Update enrichment marker
    await this.updateEnrichmentMarker(collectionName, {
      status: "completed",
      completedAt: new Date().toISOString(),
      durationMs: metrics.totalDurationMs,
      matchedFiles: metrics.matchedFiles,
      missedFiles: metrics.missedFiles,
      gitLogFileCount: this.fileMetadataCount,
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

  private flushPendingBatches(): void {
    if (this.pendingBatches.length === 0) return;

    const batches = this.pendingBatches;
    this.pendingBatches = [];

    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });

    for (const batch of batches) {
      if (!this.fileMetadata) continue;
      const pathBase = this.effectiveRoot || batch.absolutePath;
      const work = this.applier.applyFileMetadata(
        batch.collectionName,
        this.provider.key,
        this.fileMetadata,
        pathBase,
        batch.items,
        this.provider.fileTransform,
      );
      this.inFlightWork.push(work);
      this.flushApplies++;
    }
  }

  private async backfillMissedFiles(collectionName: string): Promise<void> {
    const missedPaths = Array.from(this.applier.missedFileChunks.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", { missedFiles: missedPaths.length });

    const backfillStart = Date.now();
    let backfillData: Map<string, Record<string, unknown>>;
    try {
      backfillData = await this.provider.buildFileMetadata(this.effectiveRoot!, { paths: missedPaths });
    } catch (error) {
      pipelineLog.enrichmentPhase("BACKFILL_FAILED", {
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
      const finalData = this.provider.fileTransform ? this.provider.fileTransform(data, maxEndLine) : data;
      const payload = { [this.provider.key]: { file: finalData } };

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
            console.error("[Enrichment] backfill batch failed:", error);
          }
        }
      }
    }

    const backfillDuration = Date.now() - backfillStart;
    this.applier.matchedFiles += backfilledFiles;
    this.applier.missedFiles -= backfilledFiles;

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      missedFiles: missedPaths.length,
      backfilledFiles,
      backfilledChunks: operations.length,
      stillMissed: missedPaths.length - backfilledFiles,
      durationMs: backfillDuration,
    });
  }
}
