/**
 * Debug Logger for Pipeline Operations
 *
 * Writes detailed trace logs to ~/.tea-rags-mcp/logs/ when DEBUG=1
 * Helps diagnose:
 * - Pipeline step timing
 * - Batch formation and processing
 * - Queue depth and backpressure
 * - Fallback triggers
 * - Thread/worker activity
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".tea-rags-mcp", "logs");
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export type PipelineStage = "scan" | "parse" | "git" | "embed" | "qdrant";

export interface LogContext {
  component: string;
  operation?: string;
  batchId?: string;
  threadId?: string;
}

interface StageData {
  totalMs: number;
  count: number;
  // For startStage/endStage: track active intervals per "thread"
  activeStarts: number[];
  // Wall time: track earliest start and latest end across all operations
  firstStart: number | null; // min(callTime - duration) for addTime, min(startTime) for startStage
  lastEnd: number | null; // max(callTime) for addTime, max(endTime) for endStage
}

class StageProfiler {
  private stages: Map<PipelineStage, StageData> = new Map();

  private getOrCreate(stage: PipelineStage): StageData {
    let data = this.stages.get(stage);
    if (!data) {
      data = { totalMs: 0, count: 0, activeStarts: [], firstStart: null, lastEnd: null };
      this.stages.set(stage, data);
    }
    return data;
  }

  startStage(stage: PipelineStage): void {
    const now = Date.now();
    const data = this.getOrCreate(stage);
    data.activeStarts.push(now);
    // Track earliest start time
    if (data.firstStart === null || now < data.firstStart) {
      data.firstStart = now;
    }
  }

  endStage(stage: PipelineStage): void {
    const now = Date.now();
    const data = this.getOrCreate(stage);
    const start = data.activeStarts.shift();
    if (start !== undefined) {
      data.totalMs += now - start;
      data.count++;
      // Track latest end time
      if (data.lastEnd === null || now > data.lastEnd) {
        data.lastEnd = now;
      }
    }
  }

  addTime(stage: PipelineStage, durationMs: number): void {
    const now = Date.now();
    const data = this.getOrCreate(stage);
    data.totalMs += durationMs;
    data.count++;
    // Implied start time = callTime - duration
    const impliedStart = now - durationMs;
    if (data.firstStart === null || impliedStart < data.firstStart) {
      data.firstStart = impliedStart;
    }
    // Track latest end time (now = when this work finished)
    if (data.lastEnd === null || now > data.lastEnd) {
      data.lastEnd = now;
    }
  }

  getSummary(): Record<PipelineStage, { totalMs: number; wallMs: number; count: number; percentage: number }> {
    const totalMs = Array.from(this.stages.values()).reduce((sum, d) => sum + d.totalMs, 0);
    const result = {} as Record<PipelineStage, { totalMs: number; wallMs: number; count: number; percentage: number }>;

    for (const stage of ["scan", "parse", "git", "embed", "qdrant"] as PipelineStage[]) {
      const data = this.stages.get(stage);
      if (data && data.totalMs > 0) {
        // Wall time = span from earliest start to latest end
        const wallMs = (data.firstStart !== null && data.lastEnd !== null)
          ? data.lastEnd - data.firstStart
          : 0;
        result[stage] = {
          totalMs: data.totalMs,
          wallMs,
          count: data.count,
          percentage: totalMs > 0 ? (data.totalMs / totalMs) * 100 : 0,
        };
      }
    }

    return result;
  }

  getTotalMs(): number {
    return Array.from(this.stages.values()).reduce((sum, d) => sum + d.totalMs, 0);
  }

  reset(): void {
    this.stages.clear();
  }
}

/**
 * Format milliseconds as human-readable duration (e.g., "2m 30s", "45.5s", "150ms")
 * @param ms - milliseconds
 * @param width - optional fixed width with right-padding
 */
function formatDuration(ms: number, width?: number): string {
  let result: string;
  if (ms < 1000) {
    result = `${ms}ms`;
  } else {
    const totalSeconds = ms / 1000;
    if (totalSeconds < 60) {
      result = `${totalSeconds.toFixed(1)}s`;
    } else {
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = Math.round(totalSeconds % 60);
      result = `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
    }
  }
  return width ? result.padStart(width) : result;
}

class DebugLogger {
  private logFile: string | null = null;
  private sessionStart: number;
  private profiler = new StageProfiler();
  private counters = {
    batches: 0,
    chunks: 0,
    embedCalls: 0,
    qdrantCalls: 0,
    fallbacks: 0,
  };

  constructor() {
    this.sessionStart = Date.now();

    if (DEBUG) {
      this.initLogFile();
    }
  }

  private initLogFile(): void {
    try {
      if (!existsSync(LOG_DIR)) {
        mkdirSync(LOG_DIR, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.logFile = join(LOG_DIR, `pipeline-${timestamp}.log`);

      const env = (key: string, fallback: string) =>
        process.env[key] != null ? process.env[key] : `${fallback} (default)`;

      const batchSize = parseInt(process.env.EMBEDDING_BATCH_SIZE || "1024", 10);
      const minBatchRaw = process.env.MIN_BATCH_SIZE;
      const minBatchEffective = minBatchRaw != null
        ? (parseInt(minBatchRaw, 10) || 0)
        : Math.floor(batchSize * 0.5);
      const concurrency = parseInt(process.env.EMBEDDING_CONCURRENCY || "1", 10);

      this.writeRaw(`
================================================================================
PIPELINE DEBUG LOG - Session started at ${new Date().toISOString()}
================================================================================
ENV:
  EMBEDDING_BASE_URL          = ${env("EMBEDDING_BASE_URL", "http://localhost:11434")}
  EMBEDDING_MODEL             = ${env("EMBEDDING_MODEL", "nomic-embed-text")}
  EMBEDDING_CONCURRENCY       = ${env("EMBEDDING_CONCURRENCY", "1")}
  EMBEDDING_BATCH_SIZE        = ${env("EMBEDDING_BATCH_SIZE", "1024")}
  MIN_BATCH_SIZE              = ${minBatchRaw != null ? minBatchRaw : "unset"} → effective: ${minBatchEffective}
  BATCH_FORMATION_TIMEOUT_MS  = ${env("BATCH_FORMATION_TIMEOUT_MS", "2000")}
  CHUNKER_POOL_SIZE           = ${env("CHUNKER_POOL_SIZE", "4")}
  FILE_PROCESSING_CONCURRENCY = ${env("FILE_PROCESSING_CONCURRENCY", "50")}
  MAX_IO_CONCURRENCY          = ${env("MAX_IO_CONCURRENCY", "100")}
  QDRANT_UPSERT_BATCH_SIZE    = ${env("QDRANT_UPSERT_BATCH_SIZE", "100")}
  CODE_ENABLE_GIT_METADATA    = ${env("CODE_ENABLE_GIT_METADATA", "false")}
DERIVED:
  maxQueueSize                = ${concurrency * 2} (EMBEDDING_CONCURRENCY × 2)
  backpressure ON threshold   = ${concurrency * 2} batches
  backpressure OFF threshold  = ${Math.floor(concurrency * 2 * 0.5)} batches
================================================================================
`);
    } catch (error) {
      console.error("[DebugLogger] Failed to init log file:", error);
    }
  }

  private writeRaw(message: string): void {
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, message + "\n");
      } catch {
        // Ignore write errors
      }
    }
  }

  private formatTime(): string {
    const elapsed = Date.now() - this.sessionStart;
    const sec = Math.floor(elapsed / 1000);
    const ms = elapsed % 1000;
    return `+${sec.toString().padStart(4, " ")}.${ms.toString().padStart(3, "0")}s`;
  }

  /**
   * Log a pipeline step with timing
   */
  step(ctx: LogContext, message: string, data?: Record<string, unknown>): void {
    if (!DEBUG) return;

    const time = this.formatTime();
    const prefix = `[${time}] [${ctx.component}]`;
    const suffix = data ? ` | ${JSON.stringify(data)}` : "";

    const line = `${prefix} ${message}${suffix}`;
    this.writeRaw(line);
    console.error(line);
  }

  /**
   * Log batch formation
   */
  batchFormed(
    ctx: LogContext,
    batchId: string,
    itemCount: number,
    trigger: "size" | "timeout" | "flush",
  ): void {
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
  batchComplete(
    ctx: LogContext,
    batchId: string,
    itemCount: number,
    durationMs: number,
    retryCount: number,
  ): void {
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
  batchFailed(
    ctx: LogContext,
    batchId: string,
    error: string,
    attempt: number,
    maxRetries: number,
  ): void {
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
  queueState(
    ctx: LogContext,
    queueDepth: number,
    activeWorkers: number,
    pendingItems: number,
  ): void {
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
  qdrantCall(
    ctx: LogContext,
    operation: string,
    pointCount: number,
    durationMs?: number,
  ): void {
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
  reindexPhase(
    phase: string,
    data?: Record<string, unknown>,
  ): void {
    this.step({ component: "Reindex" }, `PHASE: ${phase}`, data);
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
  getStageSummary(): Record<PipelineStage, { totalMs: number; wallMs: number; count: number; percentage: number }> {
    return this.profiler.getSummary();
  }

  /**
   * Reset stage profiler (for new indexing session)
   */
  resetProfiler(): void {
    this.profiler.reset();
  }

  /**
   * Log pipeline stats summary
   */
  summary(ctx: LogContext, stats: Record<string, unknown>): void {
    const stageSummary = this.profiler.getSummary();
    const stageTotalMs = this.profiler.getTotalMs();

    let stageBlock = "";
    if (stageTotalMs > 0) {
      // Calculate total wall time from all stages merged
      const pipelineWallMs = (stats as { uptimeMs?: number }).uptimeMs || stageTotalMs;

      // Column widths
      const W = { stage: 7, cum: 10, cpu: 6, wall: 10, wallP: 6, calls: 6 };

      stageBlock = "\nSTAGE PROFILING:\n";
      stageBlock += `  ${"stage".padEnd(W.stage)}  ${"cumul.".padStart(W.cum)}  ${"cpu%".padStart(W.cpu)}  ${"wall".padStart(W.wall)}  ${"wall%".padStart(W.wallP)}  ${"calls".padStart(W.calls)}\n`;
      stageBlock += `  ${"-".repeat(W.stage)}  ${"-".repeat(W.cum)}  ${"-".repeat(W.cpu)}  ${"-".repeat(W.wall)}  ${"-".repeat(W.wallP)}  ${"-".repeat(W.calls)}\n`;

      for (const stage of ["scan", "parse", "git", "embed", "qdrant"] as PipelineStage[]) {
        const data = stageSummary[stage];
        if (data) {
          const cpuPercent = (data.percentage.toFixed(1) + "%").padStart(W.cpu);
          const wallPercent = pipelineWallMs > 0
            ? (((data.wallMs / pipelineWallMs) * 100).toFixed(1) + "%").padStart(W.wallP)
            : "-".padStart(W.wallP);
          stageBlock += `  ${stage.padEnd(W.stage)}  ${formatDuration(data.totalMs, W.cum)}  ${cpuPercent}  ${formatDuration(data.wallMs, W.wall)}  ${wallPercent}  ${data.count.toString().padStart(W.calls)}\n`;
        }
      }
      stageBlock += `  ${"-".repeat(W.stage)}  ${"-".repeat(W.cum)}  ${"-".repeat(W.cpu)}  ${"-".repeat(W.wall)}  ${"-".repeat(W.wallP)}  ${"-".repeat(W.calls)}\n`;
      stageBlock += `  ${"TOTAL".padEnd(W.stage)}  ${formatDuration(stageTotalMs, W.cum)}  ${" ".repeat(W.cpu)}  ${formatDuration(pipelineWallMs, W.wall)}\n`;
    }

    this.writeRaw(`
--------------------------------------------------------------------------------
SUMMARY for ${ctx.component}
--------------------------------------------------------------------------------
${JSON.stringify(stats, null, 2)}
Session counters: ${JSON.stringify(this.counters)}${stageBlock}
--------------------------------------------------------------------------------
`);
  }

  /**
   * Get log file path
   */
  getLogPath(): string | null {
    return this.logFile;
  }
}

// Singleton instance
export const pipelineLog = new DebugLogger();
