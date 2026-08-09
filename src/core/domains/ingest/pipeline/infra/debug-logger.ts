/**
 * Debug Logger for Pipeline Operations
 *
 * Writes detailed trace logs to ~/.tea-rags/logs/ when DEBUG=1
 * Helps diagnose:
 * - Pipeline step timing
 * - Batch formation and processing
 * - Queue depth and backpressure
 * - Fallback triggers
 * - Thread/worker activity
 *
 * `DebugLogger` is the vocabulary the pipeline logs in — one method per event
 * worth naming — and nothing else. The work behind those methods belongs to
 * four collaborators it delegates to:
 *
 *   - `PipelineLogSink` — DEBUG gate, lazy file creation, appends
 *   - `PipelineStageProfiler` — cumulative + wall timing per stage
 *   - `SlowFileTracker` — the top-N slowest files of the session
 *   - `debug-log-format` — every string the log is made of
 *
 * Injected config (logs dir, config dump, concurrency) lives in
 * `debug-log-dependencies`, which is where `initDebugLogger` now comes from;
 * it is re-exported here so the module's import surface is unchanged.
 */

import { isDebug } from "../../../../infra/runtime.js";
import { readConcurrencyLimits } from "./debug-log-dependencies.js";
import { formatElapsed, renderSlowFilesBlock, renderStageProfilingBlock } from "./debug-log-format.js";
import { PipelineLogSink } from "./pipeline-log-sink.js";
import {
  buildStageConcurrency,
  PipelineStageProfiler,
  type PipelineStage,
  type PipelineStageProfileSummary,
} from "./pipeline-stage-profiler.js";
import { SlowFileTracker, type FileIngestRecord } from "./slow-file-tracker.js";

export { initDebugLogger } from "./debug-log-dependencies.js";
export { SlowFileTracker };
export type { FileIngestRecord, PipelineStage };
export type { PipelineConcurrencyLimits } from "./pipeline-stage-profiler.js";

export interface LogContext {
  component: string;
  operation?: string;
  batchId?: string;
  threadId?: string;
}

class DebugLogger {
  private readonly sessionStart: number;
  private readonly sink = new PipelineLogSink();
  private readonly profiler = new PipelineStageProfiler();
  private readonly slowFiles = new SlowFileTracker(20);
  private readonly counters = {
    batches: 0,
    chunks: 0,
    embedCalls: 0,
    qdrantCalls: 0,
    fallbacks: 0,
  };

  constructor() {
    this.sessionStart = Date.now();
  }

  /**
   * Log a pipeline step with timing
   */
  step(ctx: LogContext, message: string, data?: Record<string, unknown>): void {
    if (!isDebug()) return;

    const time = formatElapsed(Date.now() - this.sessionStart);
    const prefix = `[${time}] [${ctx.component}]`;
    const suffix = data ? ` | ${JSON.stringify(data)}` : "";

    const line = `${prefix} ${message}${suffix}`;
    this.sink.write(line);
    console.error(line);
  }

  /**
   * Log batch formation
   */
  batchFormed(ctx: LogContext, batchId: string, itemCount: number, trigger: "size" | "timeout" | "flush"): void {
    this.counters.batches++;
    this.step(ctx, `BATCH_FORMED: ${batchId}`, {
      items: itemCount,
      trigger,
      totalBatches: this.counters.batches,
    });
  }

  /**
   * Log batch processing start
   */
  batchStart(ctx: LogContext, batchId: string, itemCount: number): void {
    this.step(ctx, `BATCH_START: ${batchId}`, { items: itemCount });
  }

  /**
   * Log batch processing complete
   */
  batchComplete(ctx: LogContext, batchId: string, itemCount: number, durationMs: number, retryCount: number): void {
    this.counters.chunks += itemCount;
    this.step(ctx, `BATCH_COMPLETE: ${batchId}`, {
      items: itemCount,
      durationMs,
      retryCount,
      totalChunks: this.counters.chunks,
    });
  }

  /**
   * Log batch failure
   */
  batchFailed(ctx: LogContext, batchId: string, error: string, attempt: number, maxRetries: number): void {
    this.step(ctx, `BATCH_FAILED: ${batchId}`, {
      error,
      attempt,
      maxRetries,
      willRetry: attempt < maxRetries,
    });
  }

  /**
   * Log queue state change
   */
  queueState(ctx: LogContext, queueDepth: number, activeWorkers: number, pendingItems: number): void {
    this.step(ctx, "QUEUE_STATE", {
      queueDepth,
      activeWorkers,
      pendingItems,
    });
  }

  /**
   * Log backpressure event
   */
  backpressure(ctx: LogContext, isPaused: boolean, reason: string): void {
    this.step(ctx, isPaused ? "BACKPRESSURE_ON" : "BACKPRESSURE_OFF", {
      reason,
    });
  }

  /**
   * Log embedding call
   */
  embedCall(ctx: LogContext, textCount: number, durationMs?: number): void {
    this.counters.embedCalls++;
    this.step(ctx, "EMBED_CALL", {
      texts: textCount,
      durationMs,
      totalCalls: this.counters.embedCalls,
    });
  }

  /**
   * Log Qdrant call
   */
  qdrantCall(ctx: LogContext, operation: string, pointCount: number, durationMs?: number): void {
    this.counters.qdrantCalls++;
    this.step(ctx, `QDRANT_${operation.toUpperCase()}`, {
      points: pointCount,
      durationMs,
      totalCalls: this.counters.qdrantCalls,
    });
  }

  /**
   * Log fallback trigger
   */
  fallback(ctx: LogContext, level: number, reason: string): void {
    this.counters.fallbacks++;
    this.step(ctx, `FALLBACK_L${level}`, {
      reason,
      totalFallbacks: this.counters.fallbacks,
    });
  }

  /**
   * Log reindex phase
   */
  reindexPhase(phase: string, data?: Record<string, unknown>): void {
    this.step({ component: "Reindex" }, `PHASE: ${phase}`, data);
  }

  /**
   * Log per-file ingestion telemetry and feed the slow-file tracker.
   * Skipped files (secrets/chunk-limit/error) emit the event but do not
   * compete for the slow-file heap.
   */
  fileIngested(ctx: LogContext, record: FileIngestRecord): void {
    this.step(ctx, "FILE_INGESTED", { ...record });
    this.slowFiles.record(record);
  }

  /**
   * Log git enrichment phase progress (Phase 2 of two-phase indexing)
   */
  enrichmentPhase(phase: string, data?: Record<string, unknown>): void {
    this.step({ component: "GitEnrich" }, `PHASE: ${phase}`, data);
  }

  /**
   * Start timing a pipeline stage
   */
  stageStart(stage: PipelineStage): void {
    this.profiler.startStage(stage);
  }

  /**
   * End timing a pipeline stage
   */
  stageEnd(stage: PipelineStage): void {
    this.profiler.endStage(stage);
  }

  /**
   * Add pre-measured time to a pipeline stage
   */
  addStageTime(stage: PipelineStage, durationMs: number): void {
    this.profiler.addTime(stage, durationMs);
  }

  /**
   * Get stage profiling summary
   */
  getStageSummary(): PipelineStageProfileSummary {
    return this.profiler.getSummary();
  }

  /**
   * Reset stage profiler (for new indexing session).
   * Also clears the slow-file tracker — slow files are per-session like stages.
   */
  resetProfiler(): void {
    this.profiler.reset();
    this.slowFiles.reset();
  }

  /**
   * Log pipeline stats summary
   */
  summary(ctx: LogContext, stats: Record<string, unknown>): void {
    const stageTotalMs = this.profiler.getTotalMs();

    let stageBlock = "";
    if (stageTotalMs > 0) {
      stageBlock = renderStageProfilingBlock({
        stages: this.profiler.getSummary(),
        stageTotalMs,
        // Calculate total wall time from all stages merged
        pipelineWallMs: (stats as { uptimeMs?: number }).uptimeMs || stageTotalMs,
        concurrency: buildStageConcurrency(readConcurrencyLimits()),
      });
    }

    const slowFilesBlock = renderSlowFilesBlock(this.slowFiles.snapshot());

    this.sink.write(`
--------------------------------------------------------------------------------
SUMMARY for ${ctx.component}
--------------------------------------------------------------------------------
${JSON.stringify(stats, null, 2)}
Session counters: ${JSON.stringify(this.counters)}${stageBlock}${slowFilesBlock}
--------------------------------------------------------------------------------
`);
  }

  /**
   * Get log file path
   */
  getLogPath(): string | null {
    return this.sink.getLogPath();
  }
}

// Singleton instance
export const pipelineLog = new DebugLogger();
