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

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

import type { Ignore } from "ignore";

import type { QdrantManager } from "../../qdrant/client.js";
import { computeFileMetadata, GitLogReader } from "../git/git-log-reader.js";
import type { FileChurnData } from "../git/types.js";
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
  private gitLogPromise: Promise<Map<string, FileChurnData>> | null = null;
  private gitLogResult: Map<string, FileChurnData> | null = null;
  private gitLogFailed = false;

  // Git repo root (from `git rev-parse --show-toplevel`), may differ from absolutePath
  private gitRepoRoot: string | null = null;

  // Pending queue (batches waiting for git log)
  private pendingBatches: PendingBatch[] = [];

  // In-flight work tracking
  private inFlightWork: Promise<void>[] = [];
  private chunkChurnPromise: Promise<void> | null = null;

  // Ignore filter for git log path filtering
  private ignoreFilter: Ignore | null = null;

  // Path match diagnostics
  private matchedFiles = 0;
  private missedFiles = 0;
  private readonly missedPathSamples: string[] = []; // first 10
  private gitLogFileCount = 0; // total files in git log (for context)

  // Backfill: missed file relative paths → chunk IDs for post-hoc enrichment
  private readonly missedFileChunks = new Map<string, { chunkId: string; endLine: number }[]>();

  // Timing metrics
  private startTime = 0;
  private prefetchStartTime = 0;
  private prefetchEndTime = 0;
  private pipelineFlushTime = 0; // when last onChunksStored was called
  private readonly metrics: EnrichmentMetrics = {
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

  constructor(private readonly qdrant: QdrantManager) {}

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

    // Resolve actual git repo root (may differ from absolutePath due to symlinks,
    // case sensitivity on macOS, or git worktrees). Sync to avoid delaying prefetch.
    this.gitRepoRoot = this.resolveGitRepoRoot(absolutePath);
    const repoRoot = this.gitRepoRoot;

    if (repoRoot !== absolutePath) {
      pipelineLog.enrichmentPhase("REPO_ROOT_DIFFERS", {
        absolutePath,
        gitRepoRoot: repoRoot,
      });
    }

    pipelineLog.enrichmentPhase("PREFETCH_START", { path: repoRoot });

    this.gitLogPromise = this.logReader
      .buildFileMetadataMap(repoRoot)
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

        this.gitLogFileCount = result.size;

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
  onChunksStored(collectionName: string, absolutePath: string, items: ChunkItem[]): void {
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
  startChunkChurn(collectionName: string, absolutePath: string, chunkMap: Map<string, ChunkLookupEntry[]>): void {
    if (!this.logReader || this.gitLogFailed) return;

    const chunkConcurrency = parseInt(process.env.GIT_CHUNK_CONCURRENCY ?? "10", 10);
    const chunkMaxAgeMonths = parseFloat(process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6");

    if (process.env.GIT_CHUNK_ENABLED === "false") return;

    // Use git repo root for chunk churn (paths must match git log convention)
    const repoRoot = this.gitRepoRoot || absolutePath;

    // Filter chunkMap by ignore patterns (align with file-level enrichment filtering)
    let effectiveChunkMap = chunkMap;
    if (this.ignoreFilter) {
      effectiveChunkMap = new Map();
      let filtered = 0;
      for (const [filePath, entries] of chunkMap) {
        const relPath = relative(repoRoot, filePath);
        if (this.ignoreFilter.ignores(relPath)) {
          filtered++;
        } else {
          effectiveChunkMap.set(filePath, entries);
        }
      }
      if (filtered > 0) {
        pipelineLog.enrichmentPhase("CHUNK_CHURN_FILTERED", {
          filtered,
          remaining: effectiveChunkMap.size,
        });
      }
    }

    pipelineLog.enrichmentPhase("CHUNK_CHURN_START", {
      concurrency: chunkConcurrency,
      maxAgeMonths: chunkMaxAgeMonths,
      files: effectiveChunkMap.size,
    });

    const chunkChurnStart = Date.now();

    this.chunkChurnPromise = (async () => {
      try {
        if (!this.logReader) return;
        const chunkChurnMap = await this.logReader.buildChunkChurnMap(
          repoRoot,
          effectiveChunkMap,
          chunkConcurrency,
          chunkMaxAgeMonths,
          this.gitLogResult ?? undefined,
        );

        // Apply chunk-level overlays
        let chunkBatch: {
          payload: Record<string, unknown>;
          points: (string | number)[];
          key?: string;
        }[] = [];
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
            {
              chunkEnrichment: { status: "completed", overlaysApplied, durationMs: this.metrics.chunkChurnDurationMs },
            },
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

    // 3. Backfill file-level metadata for missed files (no --since, pathspec only)
    if (this.missedFileChunks.size > 0 && this.logReader) {
      await this.backfillMissedFiles(collectionName);
    }

    // 4. Chunk churn runs in background — do NOT await here.
    //    It updates Qdrant payloads independently and logs its own completion.
    //    Waiting here blocks the MCP response on large repos (taxdome: 21K files → hang).

    // Compute overlap metrics
    if (this.prefetchEndTime > 0 && this.pipelineFlushTime > 0) {
      // Overlap = time between prefetch start and min(prefetch end, pipeline flush time)
      const overlapEnd = Math.min(this.prefetchEndTime, this.pipelineFlushTime);
      this.metrics.overlapMs = Math.max(0, overlapEnd - this.prefetchStartTime);
      this.metrics.overlapRatio =
        this.metrics.prefetchDurationMs > 0 ? Math.min(1, this.metrics.overlapMs / this.metrics.prefetchDurationMs) : 0;
    }

    this.metrics.totalDurationMs = Date.now() - (this.startTime || Date.now());

    // Aggregate path match diagnostics
    this.metrics.matchedFiles = this.matchedFiles;
    this.metrics.missedFiles = this.missedFiles;
    this.metrics.missedPathSamples = [...this.missedPathSamples];
    this.metrics.gitLogFileCount = this.gitLogFileCount;

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
      gitLogFileCount: this.gitLogFileCount,
    });

    pipelineLog.enrichmentPhase("ALL_COMPLETE", {
      ...this.metrics,
    });

    return { ...this.metrics };
  }

  /**
   * Update enrichment progress marker in Qdrant (merge into __indexing_metadata__ point).
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
        console.error("[EnrichmentModule] Failed to update marker:", error);
      }
    }
  }

  // --- Private methods ---

  /**
   * Backfill file-level git metadata for files not in the main --since window.
   * Runs `git log --numstat -- <paths>` without --since restriction.
   */
  private async backfillMissedFiles(collectionName: string): Promise<void> {
    const repoRoot = this.gitRepoRoot;
    if (!repoRoot || !this.logReader) return;

    const missedPaths = Array.from(this.missedFileChunks.keys());
    pipelineLog.enrichmentPhase("BACKFILL_START", {
      missedFiles: missedPaths.length,
    });

    const backfillStart = Date.now();
    let backfillData: Map<string, FileChurnData>;
    try {
      const timeoutMs = parseInt(process.env.GIT_BACKFILL_TIMEOUT_MS ?? "30000", 10);
      backfillData = await this.logReader.buildFileMetadataForPaths(repoRoot, missedPaths, timeoutMs);
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

    for (const [relPath, chunks] of this.missedFileChunks) {
      const churnData: FileChurnData | undefined = backfillData.get(relPath);
      if (!churnData) continue; // Still no data (file outside git history)

      const maxEndLine = chunks.reduce((max, c) => Math.max(max, c.endLine), 0);
      const metadata = computeFileMetadata(churnData, maxEndLine);
      const gitPayload = { git: metadata };

      for (const chunk of chunks) {
        operations.push({ payload: gitPayload, points: [chunk.chunkId] });
      }
      backfilledFiles++;
    }

    if (operations.length > 0) {
      for (let i = 0; i < operations.length; i += BATCH_SIZE) {
        const batch = operations.slice(i, i + BATCH_SIZE);
        try {
          await this.qdrant.batchSetPayload(collectionName, batch);
        } catch (error) {
          if (process.env.DEBUG) {
            console.error("[EnrichmentModule] backfill batchSetPayload failed:", error);
          }
        }
      }
    }

    const backfillDuration = Date.now() - backfillStart;
    // Update match counters: backfilled files are no longer "missed"
    this.matchedFiles += backfilledFiles;
    this.missedFiles -= backfilledFiles;

    pipelineLog.enrichmentPhase("BACKFILL_COMPLETE", {
      missedFiles: missedPaths.length,
      backfilledFiles,
      backfilledChunks: operations.length,
      stillMissed: missedPaths.length - backfilledFiles,
      durationMs: backfillDuration,
    });
  }

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
      const work = this.applyFileMetadata(batch.collectionName, batch.absolutePath, batch.items);
      this.inFlightWork.push(work);
      this.metrics.flushApplies++;
    }
  }

  /**
   * Apply file-level git metadata to a batch of chunks via batchSetPayload.
   */
  private async applyFileMetadata(collectionName: string, absolutePath: string, items: ChunkItem[]): Promise<void> {
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

    const operations: {
      payload: Record<string, unknown>;
      points: (string | number)[];
    }[] = [];

    // Use git repo root for path computation (handles symlinks, case differences)
    const pathBase = this.gitRepoRoot || absolutePath;

    for (const [filePath, fileItems] of byFile) {
      const relativePath = relative(pathBase, filePath);
      const churnData: FileChurnData | undefined = this.gitLogResult.get(relativePath);
      if (!churnData) {
        this.missedFiles++;
        if (this.missedPathSamples.length < 10) {
          this.missedPathSamples.push(relativePath);
        }
        // Track for backfill (post-hoc enrichment without --since)
        const existing = this.missedFileChunks.get(relativePath) || [];
        for (const item of fileItems) {
          existing.push({ chunkId: item.chunkId, endLine: item.chunk.endLine });
        }
        this.missedFileChunks.set(relativePath, existing);
        continue;
      }
      this.matchedFiles++;

      const maxEndLine = fileItems.reduce((max, item) => Math.max(max, item.chunk.endLine), 0);
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

  /**
   * Resolve the actual git repo root via `git rev-parse --show-toplevel`.
   * Sync to avoid delaying the async prefetch chain.
   * Falls back to absolutePath if git command fails.
   */
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
