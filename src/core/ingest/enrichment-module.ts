/**
 * EnrichmentModule - Coordinator for streaming git metadata enrichment.
 *
 * Orchestrates three components:
 * - GitLogReader: prefetches git history (fire-and-forget at T=0)
 * - MetadataApplier: applies file-level git metadata to chunks as they arrive
 * - ChunkChurn: applies chunk-level churn overlays after pipeline flush
 *
 * Three timing scenarios:
 * 1. Git log finishes first -> callbacks apply immediately (streaming)
 * 2. Simultaneous -> mix of queuing and immediate
 * 3. Embedding finishes first -> all queued -> burst apply when git log resolves
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../adapters/qdrant/client.js";
import type { ChunkLookupEntry, EnrichmentInfo, EnrichmentMetrics } from "../types.js";
import { INDEXING_METADATA_ID } from "./constants.js";
import { runChunkChurn } from "./enrichment/chunk-churn.js";
import { MetadataApplier } from "./enrichment/metadata-applier.js";
import { GitLogReader } from "./git/git-log-reader.js";
import type { FileChurnData } from "./git/types.js";
import { pipelineLog } from "./pipeline/debug-logger.js";
import type { ChunkItem } from "./pipeline/types.js";

interface PendingBatch {
  collectionName: string;
  absolutePath: string;
  items: ChunkItem[];
}

export class EnrichmentModule {
  // Git log state
  private logReader: GitLogReader | null = null;
  private gitLogPromise: Promise<Map<string, FileChurnData>> | null = null;
  private gitLogResult: Map<string, FileChurnData> | null = null;
  private gitLogFailed = false;
  private gitRepoRoot: string | null = null;

  // Pending queue (batches waiting for git log)
  private pendingBatches: PendingBatch[] = [];

  // In-flight work tracking
  private inFlightWork: Promise<void>[] = [];
  private chunkChurnDurationMs = 0;

  // Ignore filter for git log path filtering
  private ignoreFilter: Ignore | null = null;
  private gitLogFileCount = 0;

  // Delegates
  private readonly applier: MetadataApplier;

  // Timing metrics
  private startTime = 0;
  private prefetchStartTime = 0;
  private prefetchEndTime = 0;
  private pipelineFlushTime = 0;
  private streamingApplies = 0;
  private flushApplies = 0;
  private prefetchDurationMs = 0;

  constructor(private readonly qdrant: QdrantManager) {
    this.applier = new MetadataApplier(qdrant);
  }

  /**
   * Start git log reading at T=0. Non-blocking.
   * Call this before pipeline.start() to maximize overlap.
   */
  prefetchGitLog(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
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

    // Fast check: skip if not a git repo
    if (!existsSync(join(absolutePath, ".git"))) {
      this.gitLogFailed = true;
      this.prefetchEndTime = Date.now();
      this.gitLogPromise = Promise.resolve(new Map());
      pipelineLog.enrichmentPhase("PREFETCH_SKIPPED", { reason: "not a git repo" });
      return;
    }

    this.logReader = new GitLogReader();
    this.gitRepoRoot = this.resolveGitRepoRoot(absolutePath);
    const repoRoot = this.gitRepoRoot;

    if (repoRoot !== absolutePath) {
      pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", { absolutePath, gitRepoRoot: repoRoot });
    }

    pipelineLog.enrichmentPhase("PREFETCH_START", { path: repoRoot });

    this.gitLogPromise = this.logReader
      .buildFileMetadataMap(repoRoot)
      .then((result) => {
        this.prefetchEndTime = Date.now();
        this.gitLogResult = result;
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

        this.gitLogFileCount = result.size;

        pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
          filesInLog: result.size,
          durationMs: this.prefetchDurationMs,
        });
        pipelineLog.addStageTime("gitLog", this.prefetchDurationMs);

        this.flushPendingBatches();
        return result;
      })
      .catch((error) => {
        this.gitLogFailed = true;
        this.prefetchEndTime = Date.now();
        this.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;
        console.error("[Enrichment] Git log prefetch failed:", error instanceof Error ? error.message : error);
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

    if (this.gitLogFailed) return;

    if (this.gitLogResult) {
      const pathBase = this.gitRepoRoot || absolutePath;
      const work = this.applier.applyFileMetadata(collectionName, this.gitLogResult, pathBase, items);
      this.inFlightWork.push(work);
      this.streamingApplies++;
      pipelineLog.enrichmentPhase("STREAMING_APPLY", { chunks: items.length });
    } else {
      this.pendingBatches.push({ collectionName, absolutePath, items });
    }
  }

  /**
   * Start chunk churn (Phase 2b). Fire-and-forget, tracked internally.
   */
  startChunkChurn(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    if (!this.logReader || this.gitLogFailed) return;

    const repoRoot = this.gitRepoRoot || absolutePath;
    runChunkChurn(
      this.qdrant,
      collectionName,
      absolutePath,
      chunkMap,
      this.logReader,
      this.gitLogResult ?? undefined,
      repoRoot,
      this.ignoreFilter,
    )
      .then((durationMs) => {
        this.chunkChurnDurationMs = durationMs;
      })
      .catch(() => {});
  }

  /**
   * Wait for all in-flight enrichment work to complete.
   */
  async awaitCompletion(collectionName: string): Promise<EnrichmentMetrics> {
    // 1. Wait for git log prefetch
    if (this.gitLogPromise) {
      await this.gitLogPromise.catch(() => {});
    }

    // 2. Wait for all streaming applies
    if (this.inFlightWork.length > 0) {
      await Promise.allSettled(this.inFlightWork);
      this.inFlightWork = [];
    }

    // 3. Backfill file-level metadata for missed files
    if (this.applier.missedFileChunks.size > 0 && this.logReader && this.gitRepoRoot) {
      await this.applier.backfillMissedFiles(collectionName, this.logReader, this.gitRepoRoot);
    }

    // 4. Chunk churn runs in background — do NOT await here.

    // Compute overlap metrics
    const metrics: EnrichmentMetrics = {
      prefetchDurationMs: this.prefetchDurationMs,
      overlapMs: 0,
      overlapRatio: 0,
      streamingApplies: this.streamingApplies,
      flushApplies: this.flushApplies,
      chunkChurnDurationMs: this.chunkChurnDurationMs,
      totalDurationMs: Date.now() - (this.startTime || Date.now()),
      matchedFiles: this.applier.matchedFiles,
      missedFiles: this.applier.missedFiles,
      missedPathSamples: [...this.applier.missedPathSamples],
      gitLogFileCount: this.gitLogFileCount,
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
      gitLogFileCount: this.gitLogFileCount,
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
      if (!this.gitLogResult) continue;
      const pathBase = this.gitRepoRoot || batch.absolutePath;
      const work = this.applier.applyFileMetadata(batch.collectionName, this.gitLogResult, pathBase, batch.items);
      this.inFlightWork.push(work);
      this.flushApplies++;
    }
  }

  private resolveGitRepoRoot(absolutePath: string): string {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: absolutePath,
        encoding: "utf-8",
      }).trim();
    } catch {
      return absolutePath;
    }
  }
}
