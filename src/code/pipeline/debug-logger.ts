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
  activeStart: number | null;
}

class StageProfiler {
  private stages: Map<PipelineStage, StageData> = new Map();

  private getOrCreate(stage: PipelineStage): StageData {
    let data = this.stages.get(stage);
    if (!data) {
      data = { totalMs: 0, count: 0, activeStart: null };
      this.stages.set(stage, data);
    }
    return data;
  }

  startStage(stage: PipelineStage): void {
    const data = this.getOrCreate(stage);
    data.activeStart = Date.now();
  }

  endStage(stage: PipelineStage): void {
    const data = this.getOrCreate(stage);
    if (data.activeStart !== null) {
      data.totalMs += Date.now() - data.activeStart;
      data.count++;
      data.activeStart = null;
    }
  }

  addTime(stage: PipelineStage, durationMs: number): void {
    const data = this.getOrCreate(stage);
    data.totalMs += durationMs;
    data.count++;
  }

  getSummary(): Record<PipelineStage, { totalMs: number; count: number; percentage: number }> {
    const totalMs = Array.from(this.stages.values()).reduce((sum, d) => sum + d.totalMs, 0);
    const result = {} as Record<PipelineStage, { totalMs: number; count: number; percentage: number }>;

    for (const stage of ["scan", "parse", "git", "embed", "qdrant"] as PipelineStage[]) {
      const data = this.stages.get(stage);
      if (data && data.totalMs > 0) {
        result[stage] = {
          totalMs: data.totalMs,
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

      this.writeRaw(`
================================================================================
PIPELINE DEBUG LOG - Session started at ${new Date().toISOString()}
================================================================================
ENV: DEBUG=${process.env.DEBUG}
     EMBEDDING_CONCURRENCY=${process.env.EMBEDDING_CONCURRENCY || "1 (default)"}
     EMBEDDING_BATCH_SIZE=${process.env.EMBEDDING_BATCH_SIZE || "1024 (default, chunks per embedding batch)"}
     QDRANT_UPSERT_BATCH_SIZE=${process.env.QDRANT_UPSERT_BATCH_SIZE || process.env.CODE_BATCH_SIZE || "100 (default, points per Qdrant upsert)"}
     BATCH_FORMATION_TIMEOUT_MS=${process.env.BATCH_FORMATION_TIMEOUT_MS || "2000 (default)"}
     FILE_PROCESSING_CONCURRENCY=${process.env.FILE_PROCESSING_CONCURRENCY || "50 (default)"}
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
  getStageSummary(): Record<PipelineStage, { totalMs: number; count: number; percentage: number }> {
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
      stageBlock = "\nSTAGE PROFILING:\n";
      for (const stage of ["scan", "parse", "git", "embed", "qdrant"] as PipelineStage[]) {
        const data = stageSummary[stage];
        if (data) {
          stageBlock += `  ${stage.padEnd(9)}: ${data.totalMs.toString().padStart(6)}ms  (${data.percentage.toFixed(1).padStart(5)}%)  [${data.count.toString().padStart(4)} calls]\n`;
        }
      }
      stageBlock += `  ${"TOTAL".padEnd(9)}: ${stageTotalMs.toString().padStart(6)}ms\n`;
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
