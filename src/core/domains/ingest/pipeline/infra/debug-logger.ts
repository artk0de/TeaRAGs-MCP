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
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { isDebug } from "./runtime.js";

/** Module-level state populated via initDebugLogger() from bootstrap */
let _logsDir: string | null = null;
let _configDumpFn: (() => Record<string, unknown>) | null = null;
let _concurrencyFn:
  | (() => { pipelineConcurrency: number; chunkerPoolSize: number; gitChunkConcurrency: number })
  | null = null;

/**
 * Initialize debug logger with injected dependencies (call once from bootstrap).
 * If not called, the logger still works but skips config dump header and concurrency stats.
 */
export function initDebugLogger(opts: {
  logsDir: string;
  getConfigDump: () => Record<string, unknown>;
  getConcurrency: () => { pipelineConcurrency: number; chunkerPoolSize: number; gitChunkConcurrency: number };
}): void {
  _logsDir = opts.logsDir;
  _configDumpFn = opts.getConfigDump;
  _concurrencyFn = opts.getConcurrency;
}

/** Filesystem-safe local timestamp: 2026-03-06T01-23-45 */
function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

/**
 * Per-file ingestion telemetry record emitted by FileProcessor.
 * Used for post-mortem analysis — "which files were slowest to parse?".
 */
export interface FileIngestRecord {
  /** Relative path from basePath. */
  path: string;
  language: string;
  /** File size in bytes (UTF-8). 0 for errors before read. */
  bytes: number;
  /** Number of chunks produced. 0 if skipped. */
  chunks: number;
  /** Parse duration in ms. 0 if skipped before parsing. */
  parseMs: number;
  skipped?: boolean;
  skipReason?: "secrets" | "chunk-limit" | "error";
}

/**
 * Tracks the top-N slowest non-skipped files by parseMs within a session.
 *
 * Skipped files (secrets, chunk-limit, errors) do not compete for the slow-file
 * heap — they carry their own signal in the FILE_INGESTED event and would
 * distort "slowest" semantics.
 */
export class SlowFileTracker {
  private readonly heap: FileIngestRecord[] = [];
  private readonly capacity: number;

  constructor(capacity = 20) {
    this.capacity = capacity;
  }

  record(entry: FileIngestRecord): void {
    if (entry.skipped) return;
    this.heap.push(entry);
    this.heap.sort((a, b) => b.parseMs - a.parseMs);
    if (this.heap.length > this.capacity) {
      this.heap.length = this.capacity;
    }
  }

  snapshot(): readonly FileIngestRecord[] {
    return [...this.heap];
  }

  reset(): void {
    this.heap.length = 0;
  }
}

export type PipelineStage =
  | "scan"
  | "parse"
  | "git"
  | "embed"
  | "qdrant"
  | "enrichment_prefetch"
  | "enrichGit"
  | "enrichApply"
  | "chunkChurn";

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
  private readonly stages: Map<PipelineStage, StageData> = new Map();

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

    for (const stage of [
      "scan",
      "parse",
      "git",
      "embed",
      "qdrant",
      "enrichment_prefetch",
      "enrichGit",
      "enrichApply",
      "chunkChurn",
    ] as PipelineStage[]) {
      const data = this.stages.get(stage);
      if (data && data.totalMs > 0) {
        // Wall time = span from earliest start to latest end
        const wallMs = data.firstStart !== null && data.lastEnd !== null ? data.lastEnd - data.firstStart : 0;
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
  private readonly sessionStart: number;
  private readonly profiler = new StageProfiler();
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

  private initLogFile(): void {
    try {
      const logDir = _logsDir;
      if (!logDir) {
        // No logsDir configured — skip file logging
        return;
      }

      if (!existsSync(logDir)) {
        mkdirSync(logDir, { recursive: true });
      }

      const timestamp = localTimestamp();
      this.logFile = join(logDir, `pipeline-${timestamp}.log`);

      let dump: Record<string, unknown> = {};
      try {
        if (_configDumpFn) {
          dump = _configDumpFn();
        }
      } catch {
        // Config not available — fall back to empty dump
      }

      // Format config dump as aligned key=value pairs
      const dumpEntries = Object.entries(dump);
      const maxKeyLen = dumpEntries.length > 0 ? Math.max(...dumpEntries.map(([k]) => k.length)) : 0;
      const configLines = dumpEntries.map(([k, v]) => `  ${k.padEnd(maxKeyLen)} = ${String(v)}`).join("\n");

      // Derive concurrency stats
      const concurrency = (dump["ingest.tune.pipelineConcurrency"] as number | undefined) ?? 1;

      this.writeRaw(`
================================================================================
PIPELINE DEBUG LOG - Session started at ${new Date().toLocaleString()}
================================================================================
CONFIG:
${configLines}
  GIT_ENRICHMENT${"".padEnd(Math.max(0, maxKeyLen - "GIT_ENRICHMENT".length))} = background (CLI primary, isomorphic-git fallback)
DERIVED:
  maxQueueSize                = ${concurrency * 2} (ingest.tune.pipelineConcurrency × 2)
  backpressure ON threshold   = ${concurrency * 2} batches
  backpressure OFF threshold  = ${Math.floor(concurrency * 2 * 0.5)} batches
================================================================================
`);
    } catch (error) {
      console.error("[DebugLogger] Failed to init log file:", error);
    }
  }

  private writeRaw(message: string): void {
    if (!isDebug()) return;
    if (!this.logFile) {
      this.initLogFile();
    }
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, `${message}\n`);
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
    if (!isDebug()) return;

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
  getStageSummary(): Record<PipelineStage, { totalMs: number; wallMs: number; count: number; percentage: number }> {
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
    const stageSummary = this.profiler.getSummary();
    const stageTotalMs = this.profiler.getTotalMs();

    let stageBlock = "";
    if (stageTotalMs > 0) {
      // Calculate total wall time from all stages merged
      const pipelineWallMs = (stats as { uptimeMs?: number }).uptimeMs || stageTotalMs;

      // Concurrency per stage (for estimating incremental time)
      let pipelineConcurrency = 1;
      let chunkerPoolSize = 4;
      let gitChunkConcurrency = 10;
      try {
        if (_concurrencyFn) {
          ({ pipelineConcurrency, chunkerPoolSize, gitChunkConcurrency } = _concurrencyFn());
        }
      } catch {
        // Config not available — use defaults
      }
      const concurrency: Record<PipelineStage, number> = {
        scan: 1, // Serial file scanning
        parse: chunkerPoolSize,
        git: gitChunkConcurrency,
        embed: pipelineConcurrency,
        qdrant: pipelineConcurrency,
        enrichment_prefetch: 1, // Parallel per-provider prefetch
        enrichGit: 1, // Background, single-threaded
        enrichApply: 1, // Streaming setPayload calls
        chunkChurn: gitChunkConcurrency,
      };

      // Column widths
      const W = { stage: 11, cum: 10, cpu: 6, wall: 10, wallP: 6, added: 8, calls: 6 };

      stageBlock = "\nSTAGE PROFILING:\n";
      stageBlock += `  ${"stage".padEnd(W.stage)}  ${"cumul.".padStart(W.cum)}  ${"cpu%".padStart(W.cpu)}  ${"wall".padStart(W.wall)}  ${"wall%".padStart(W.wallP)}  ${"~added".padStart(W.added)}  ${"calls".padStart(W.calls)}\n`;
      stageBlock += `  ${"-".repeat(W.stage)}  ${"-".repeat(W.cum)}  ${"-".repeat(W.cpu)}  ${"-".repeat(W.wall)}  ${"-".repeat(W.wallP)}  ${"-".repeat(W.added)}  ${"-".repeat(W.calls)}\n`;

      let totalAddedMs = 0;
      for (const stage of [
        "scan",
        "parse",
        "git",
        "embed",
        "qdrant",
        "enrichment_prefetch",
        "enrichGit",
        "enrichApply",
        "chunkChurn",
      ] as PipelineStage[]) {
        const data = stageSummary[stage];
        if (data) {
          const cpuPercent = `${data.percentage.toFixed(1)}%`.padStart(W.cpu);
          const wallPercent =
            pipelineWallMs > 0
              ? `${((data.wallMs / pipelineWallMs) * 100).toFixed(1)}%`.padStart(W.wallP)
              : "-".padStart(W.wallP);
          // Estimated incremental time = cumulative / concurrency
          const addedMs = Math.round(data.totalMs / concurrency[stage]);
          totalAddedMs += addedMs;
          stageBlock += `  ${stage.padEnd(W.stage)}  ${formatDuration(data.totalMs, W.cum)}  ${cpuPercent}  ${formatDuration(data.wallMs, W.wall)}  ${wallPercent}  ${formatDuration(addedMs, W.added)}  ${data.count.toString().padStart(W.calls)}\n`;
        }
      }
      stageBlock += `  ${"-".repeat(W.stage)}  ${"-".repeat(W.cum)}  ${"-".repeat(W.cpu)}  ${"-".repeat(W.wall)}  ${"-".repeat(W.wallP)}  ${"-".repeat(W.added)}  ${"-".repeat(W.calls)}\n`;
      stageBlock += `  ${"TOTAL".padEnd(W.stage)}  ${formatDuration(stageTotalMs, W.cum)}  ${" ".repeat(W.cpu)}  ${formatDuration(pipelineWallMs, W.wall)}  ${" ".repeat(W.wallP)}  ${formatDuration(totalAddedMs, W.added)}\n`;
      stageBlock += `\n  ~added = cumul. / concurrency (estimated incremental cost)\n`;
    }

    let slowFilesBlock = "";
    const slowFiles = this.slowFiles.snapshot();
    if (slowFiles.length > 0) {
      slowFilesBlock = `\nSLOW_FILES_TOP_${slowFiles.length}:\n${JSON.stringify(slowFiles, null, 2)}\n`;
    }

    this.writeRaw(`
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
    return this.logFile;
  }
}

// Singleton instance
export const pipelineLog = new DebugLogger();
