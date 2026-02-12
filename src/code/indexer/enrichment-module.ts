/**
 * EnrichmentModule - Streaming git metadata enrichment for indexed chunks.
 *
 * Replaces the old fire-and-forget approach with a streaming API that
 * overlaps git log reading with embedding, applying metadata as batches
 * are stored in Qdrant.
 *
 * Three timing scenarios:
 * 1. Git log finishes first -> callbacks apply immediately (streaming)
 * 2. Simultaneous -> mix of queuing and immediate
 * 3. Embedding finishes first -> all queued -> burst apply when git log resolves
 */

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Ignore } from "ignore";
import type { QdrantManager } from "../../qdrant/client.js";
import { GitLogReader, computeFileMetadata } from "../git/git-log-reader.js";
import { pipelineLog } from "../pipeline/debug-logger.js";
import type { ChunkItem } from "../pipeline/types.js";
import type { ChunkLookupEntry, EnrichmentInfo, EnrichmentMetrics } from "../types.js";
import { INDEXING_METADATA_ID } from "./shared.js";

const BATCH_SIZE = 100;

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

export class EnrichmentModule {
  // Git log state
  private logReader: GitLogReader | null = null;
  private gitLogPromise: Promise<Map<string, any>> | null = null;
  private gitLogResult: Map<string, any> | null = null;
  private gitLogFailed = false;

  // Pending queue (batches waiting for git log)
  private pendingBatches: PendingBatch[] = [];

  // In-flight work tracking
  private inFlightWork: Promise<void>[] = [];
  private chunkChurnPromise: Promise<void> | null = null;

  // Ignore filter for git log path filtering
  private ignoreFilter: Ignore | null = null;

  // Path mismatch diagnostics
  private matchedFiles = 0;
  private missedFiles = 0;
  private missedPathSamples: string[] = []; // first 10

  // Timing metrics
  private startTime = 0;
  private prefetchStartTime = 0;
  private prefetchEndTime = 0;
  private pipelineFlushTime = 0; // when last onChunksStored was called
  private metrics: EnrichmentMetrics = {
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
    estimatedSavedMs: 0,
  };

  constructor(private qdrant: QdrantManager) {}

  /**
   * Start git log reading at T=0. Non-blocking.
   * Call this before pipeline.start() to maximize overlap.
   *
   * @param collectionName - optional, used to set enrichment "in_progress" marker in Qdrant
   */
  prefetchGitLog(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
    this.startTime = Date.now();
    this.prefetchStartTime = Date.now();
    this.ignoreFilter = ignoreFilter ?? null;

    // Set enrichment marker to "in_progress" so get_index_status shows it
    if (collectionName) {
      this.updateEnrichmentMarker(collectionName, {
        status: "in_progress",
        startedAt: new Date().toISOString(),
      }).catch(() => {}); // non-blocking, best-effort
    }

    // Fast check: skip if not a git repo (avoids spawning CLI on non-git dirs)
    if (!existsSync(join(absolutePath, ".git"))) {
      this.gitLogFailed = true;
      this.prefetchEndTime = Date.now();
      this.gitLogPromise = Promise.resolve(new Map());
      pipelineLog.enrichmentPhase("PREFETCH_SKIPPED", { reason: "not a git repo" });
      return;
    }

    this.logReader = new GitLogReader();

    pipelineLog.enrichmentPhase("PREFETCH_START", { path: absolutePath });

    this.gitLogPromise = this.logReader
      .buildFileMetadataMap(absolutePath)
      .then((result) => {
        this.prefetchEndTime = Date.now();
        this.gitLogResult = result;
        this.metrics.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;

        // Filter git log results by ignore patterns (.gitignore, .contextignore)
        if (this.ignoreFilter) {
          let filtered = 0;
          for (const [path] of result) {
            if (this.ignoreFilter.ignores(path)) {
              result.delete(path);
              filtered++;
            }
          }
          if (filtered > 0) {
            pipelineLog.enrichmentPhase("PREFETCH_FILTERED", {
              filtered,
              remainingFiles: result.size,
            });
          }
        }

        pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
          filesInLog: result.size,
          durationMs: this.metrics.prefetchDurationMs,
        });
        pipelineLog.addStageTime("gitLog", this.metrics.prefetchDurationMs);

        // Flush any pending batches that queued while git log was reading
        this.flushPendingBatches();

        return result;
      })
      .catch((error) => {
        this.gitLogFailed = true;
        this.prefetchEndTime = Date.now();
        this.metrics.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;
        console.error("[EnrichmentModule] Git log prefetch failed:", error instanceof Error ? error.message : error);
        pipelineLog.enrichmentPhase("PREFETCH_FAILED", {
          error: error instanceof Error ? error.message : String(error),
          durationMs: this.metrics.prefetchDurationMs,
        });

        // Discard pending batches — no git data to apply
        this.pendingBatches = [];
        return new Map();
      });
  }

  /**
   * Called per-batch by pipeline callback after chunks are stored in Qdrant.
   * Applies file-level git metadata to the newly stored chunks.
   */
  onChunksStored(
    collectionName: string,
    absolutePath: string,
    items: ChunkItem[],
  ): void {
    this.pipelineFlushTime = Date.now();

    if (this.gitLogFailed) {
      return; // No git data available
    }

    if (this.gitLogResult) {
      // Git log already resolved — apply immediately (streaming)
      const work = this.applyFileMetadata(collectionName, absolutePath, items);
      this.inFlightWork.push(work);
      this.metrics.streamingApplies++;

      pipelineLog.enrichmentPhase("STREAMING_APPLY", {
        chunks: items.length,
      });
    } else {
      // Git log still reading — queue for later
      this.pendingBatches.push({ collectionName, absolutePath, items });
    }
  }

  /**
   * Start chunk churn (Phase 2b). Fire-and-forget, tracked internally.
   * Call this after pipeline flush.
   */
  startChunkChurn(
    collectionName: string,
    absolutePath: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): void {
    if (!this.logReader || this.gitLogFailed) return;

    const chunkConcurrency = parseInt(process.env.GIT_CHUNK_CONCURRENCY ?? "10", 10);
    const chunkMaxAgeMonths = parseFloat(process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6");

    if (process.env.GIT_CHUNK_ENABLED === "false") return;

    pipelineLog.enrichmentPhase("CHUNK_CHURN_START", {
      concurrency: chunkConcurrency,
      maxAgeMonths: chunkMaxAgeMonths,
      files: chunkMap.size,
    });

    const chunkChurnStart = Date.now();

    this.chunkChurnPromise = (async () => {
      try {
        const chunkChurnMap = await this.logReader!.buildChunkChurnMap(
          absolutePath,
          chunkMap,
          chunkConcurrency,
          chunkMaxAgeMonths,
        );

        // Apply chunk-level overlays
        let chunkBatch: Array<{
          payload: Record<string, any>;
          points: (string | number)[];
          key?: string;
        }> = [];
        let overlaysApplied = 0;

        for (const [, overlayMap] of chunkChurnMap) {
          for (const [chunkId, overlay] of overlayMap) {
            chunkBatch.push({
              payload: {
                chunkCommitCount: overlay.chunkCommitCount,
                chunkChurnRatio: overlay.chunkChurnRatio,
                chunkContributorCount: overlay.chunkContributorCount,
                chunkBugFixRate: overlay.chunkBugFixRate,
                chunkLastModifiedAt: overlay.chunkLastModifiedAt,
                chunkAgeDays: overlay.chunkAgeDays,
              },
              points: [chunkId],
              key: "git",
            });

            if (chunkBatch.length >= BATCH_SIZE) {
              try {
                await this.qdrant.batchSetPayload(collectionName, chunkBatch);
                overlaysApplied += chunkBatch.length;
              } catch (error) {
                if (process.env.DEBUG) {
                  console.error("[EnrichmentModule] Chunk churn batch failed:", error);
                }
              }
              chunkBatch = [];
            }
          }
        }

        // Flush remaining
        if (chunkBatch.length > 0) {
          try {
            await this.qdrant.batchSetPayload(collectionName, chunkBatch);
            overlaysApplied += chunkBatch.length;
          } catch (error) {
            if (process.env.DEBUG) {
              console.error("[EnrichmentModule] Chunk churn final batch failed:", error);
            }
          }
        }

        this.metrics.chunkChurnDurationMs = Date.now() - chunkChurnStart;

        // Write chunk enrichment status to Qdrant (separate key from enrichment to avoid overwrite)
        try {
          await this.qdrant.setPayload(
            collectionName,
            { chunkEnrichment: { status: "completed", overlaysApplied, durationMs: this.metrics.chunkChurnDurationMs } },
            { points: [INDEXING_METADATA_ID] },
          );
        } catch (error) {
          if (process.env.DEBUG) {
            console.error("[EnrichmentModule] Failed to update chunk enrichment marker:", error);
          }
        }

        pipelineLog.enrichmentPhase("CHUNK_CHURN_COMPLETE", {
          overlaysApplied,
          durationMs: this.metrics.chunkChurnDurationMs,
        });
      } catch (error) {
        this.metrics.chunkChurnDurationMs = Date.now() - chunkChurnStart;
        console.error("[EnrichmentModule] Chunk churn failed:", error);
        pipelineLog.enrichmentPhase("CHUNK_CHURN_FAILED", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }

  /**
   * Wait for all in-flight enrichment work to complete.
   * Returns timing metrics showing overlap achieved.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    // 1. Wait for git log prefetch
    if (this.gitLogPromise) {
      await this.gitLogPromise.catch(() => {}); // errors already handled in prefetchGitLog
    }

    // 2. Wait for all streaming applies
    if (this.inFlightWork.length > 0) {
      await Promise.allSettled(this.inFlightWork);
      this.inFlightWork = [];
    }

    // 3. Chunk churn runs in background — do NOT await here.
    //    It updates Qdrant payloads independently and logs its own completion.
    //    Waiting here blocks the MCP response on large repos (taxdome: 21K files → hang).

    // Compute overlap metrics
    if (this.prefetchEndTime > 0 && this.pipelineFlushTime > 0) {
      // Overlap = time between prefetch start and min(prefetch end, pipeline flush time)
      const overlapEnd = Math.min(this.prefetchEndTime, this.pipelineFlushTime);
      this.metrics.overlapMs = Math.max(0, overlapEnd - this.prefetchStartTime);
      this.metrics.overlapRatio =
        this.metrics.prefetchDurationMs > 0
          ? Math.min(1, this.metrics.overlapMs / this.metrics.prefetchDurationMs)
          : 0;
    }

    this.metrics.totalDurationMs = Date.now() - (this.startTime || Date.now());

    // Aggregate path mismatch diagnostics
    this.metrics.matchedFiles = this.matchedFiles;
    this.metrics.missedFiles = this.missedFiles;
    this.metrics.missedPathSamples = [...this.missedPathSamples];

    // Estimate streaming savings:
    // Sequential = prefetch + all enrichApply time (serial)
    // Actual = total wall time (with overlap)
    // Saved = overlap time that was hidden behind embedding
    this.metrics.estimatedSavedMs = Math.max(0, this.metrics.overlapMs);

    // Update enrichment marker
    await this.updateEnrichmentMarker(collectionName, {
      status: "completed",
      completedAt: new Date().toISOString(),
      durationMs: this.metrics.totalDurationMs,
      matchedFiles: this.metrics.matchedFiles,
      missedFiles: this.metrics.missedFiles,
    });

    pipelineLog.enrichmentPhase("ALL_COMPLETE", {
      ...this.metrics,
    });

    return { ...this.metrics };
  }

  /**
   * Update enrichment progress marker in Qdrant (merge into __indexing_metadata__ point).
   */
  async updateEnrichmentMarker(
    collectionName: string,
    info: Partial<EnrichmentInfo>,
  ): Promise<void> {
    try {
      const enrichment: Record<string, any> = { ...info };
      if (info.totalFiles && info.processedFiles !== undefined) {
        enrichment.percentage = Math.round((info.processedFiles / info.totalFiles) * 100);
      }
      await this.qdrant.setPayload(
        collectionName,
        { enrichment },
        { points: [INDEXING_METADATA_ID] },
      );
    } catch (error) {
      if (process.env.DEBUG) {
        console.error("[EnrichmentModule] Failed to update marker:", error);
      }
    }
  }

  // --- Private methods ---

  /**
   * Flush all pending batches that were queued while git log was reading.
   */
  private flushPendingBatches(): void {
    if (this.pendingBatches.length === 0) return;

    const batches = this.pendingBatches;
    this.pendingBatches = [];

    pipelineLog.enrichmentPhase("FLUSH_APPLY", {
      batches: batches.length,
      chunks: batches.reduce((sum, b) => sum + b.items.length, 0),
    });

    for (const batch of batches) {
      const work = this.applyFileMetadata(
        batch.collectionName,
        batch.absolutePath,
        batch.items,
      );
      this.inFlightWork.push(work);
      this.metrics.flushApplies++;
    }
  }

  /**
   * Apply file-level git metadata to a batch of chunks via batchSetPayload.
   */
  private async applyFileMetadata(
    collectionName: string,
    absolutePath: string,
    items: ChunkItem[],
  ): Promise<void> {
    if (!this.gitLogResult) return;

    const applyStart = Date.now();

    // Group items by filePath
    const byFile = new Map<string, ChunkItem[]>();
    for (const item of items) {
      const fp = item.chunk.metadata.filePath;
      const existing = byFile.get(fp) || [];
      existing.push(item);
      byFile.set(fp, existing);
    }

    const operations: Array<{
      payload: Record<string, any>;
      points: (string | number)[];
    }> = [];

    for (const [filePath, fileItems] of byFile) {
      const relativePath = relative(absolutePath, filePath);
      const churnData = this.gitLogResult.get(relativePath);
      if (!churnData) {
        this.missedFiles++;
        if (this.missedPathSamples.length < 10) {
          this.missedPathSamples.push(relativePath);
        }
        continue;
      }
      this.matchedFiles++;

      const maxEndLine = fileItems.reduce(
        (max, item) => Math.max(max, item.chunk.endLine),
        0,
      );
      const metadata = computeFileMetadata(churnData, maxEndLine);
      const gitPayload = { git: metadata };

      for (const item of fileItems) {
        operations.push({ payload: gitPayload, points: [item.chunkId] });
      }
    }

    if (operations.length === 0) return;

    // Flush in batches of BATCH_SIZE
    for (let i = 0; i < operations.length; i += BATCH_SIZE) {
      const batch = operations.slice(i, i + BATCH_SIZE);
      try {
        await this.qdrant.batchSetPayload(collectionName, batch);
      } catch (error) {
        if (process.env.DEBUG) {
          console.error("[EnrichmentModule] batchSetPayload failed:", error);
        }
      }
    }

    const applyDuration = Date.now() - applyStart;
    pipelineLog.addStageTime("enrichApply", applyDuration);
  }
}
