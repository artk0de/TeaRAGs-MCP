/**
 * Cumulative and wall-clock timing per pipeline stage.
 *
 * Split out of `debug-logger.ts`: measuring stages is arithmetic over a stage
 * map, not logging. Nothing here touches the filesystem or the log format, so
 * the profiler is directly testable and the logger keeps one job.
 *
 * Two recording modes feed the same accumulator. `startStage`/`endStage`
 * brackets an interval as it happens; `addTime` posts a duration measured
 * somewhere the logger cannot bracket (worker thread, child process, git) and
 * back-dates its implied start. Both track the earliest start and the latest
 * end, which is what lets the summary print wall time beside cumulative time —
 * the gap between the two is how a stage that should fan out but runs serial
 * gives itself away.
 */

export type PipelineStage =
  // Setup stages — run before the first file is processed (csyve attribution).
  // Each is a one-shot measurement around an existing setup sub-step so the
  // un-instrumented "process start → first FILE_INGESTED" window can be split
  // into embedding warmup, project scan, qdrant collection setup, and codegraph
  // init. Ordered first so they read top-of-table in the STAGE PROFILING block.
  | "embed-warmup"
  | "scan"
  | "qdrant-setup"
  | "codegraph-init"
  | "parse"
  | "git"
  | "embed"
  | "qdrant"
  | "enrichment_prefetch"
  | "enrichGit"
  | "enrichApply"
  | "chunkChurn"
  // bd tea-rags-mcp-v2mlw: per-batch file-phase blame pass (cache hits + misses).
  | "blame";

/**
 * Canonical stage order — shared by the summary map and the rendered table so
 * the two can never drift into disagreeing about which stages exist.
 */
export const PIPELINE_STAGE_ORDER: readonly PipelineStage[] = [
  "embed-warmup",
  "scan",
  "qdrant-setup",
  "codegraph-init",
  "parse",
  "git",
  "embed",
  "qdrant",
  "enrichment_prefetch",
  "enrichGit",
  "enrichApply",
  "chunkChurn",
  "blame",
];

/**
 * How many of each stage run at once. Injected from config at bootstrap; the
 * summary divides cumulative time by it to estimate incremental wall cost.
 */
export interface PipelineConcurrencyLimits {
  pipelineConcurrency: number;
  chunkerPoolSize: number;
  gitChunkConcurrency: number;
}

/** One stage's timing as reported to consumers. */
export interface PipelineStageProfile {
  totalMs: number;
  wallMs: number;
  count: number;
  percentage: number;
}

/** Timing for every stage that recorded work — stages with none are absent. */
export type PipelineStageProfileSummary = Record<PipelineStage, PipelineStageProfile>;

interface StageData {
  totalMs: number;
  count: number;
  // For startStage/endStage: track active intervals per "thread"
  activeStarts: number[];
  // Wall time: track earliest start and latest end across all operations
  firstStart: number | null; // min(callTime - duration) for addTime, min(startTime) for startStage
  lastEnd: number | null; // max(callTime) for addTime, max(endTime) for endStage
}

export class PipelineStageProfiler {
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

  getSummary(): PipelineStageProfileSummary {
    const totalMs = Array.from(this.stages.values()).reduce((sum, d) => sum + d.totalMs, 0);
    const result = {} as PipelineStageProfileSummary;

    for (const stage of PIPELINE_STAGE_ORDER) {
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
 * Effective concurrency per stage — the divisor behind the summary's `~added`
 * column, where `cumulative / concurrency` estimates what the stage actually
 * added to wall time.
 */
export function buildStageConcurrency({
  pipelineConcurrency,
  chunkerPoolSize,
  gitChunkConcurrency,
}: PipelineConcurrencyLimits): Record<PipelineStage, number> {
  return {
    "embed-warmup": 1, // Serial one-shot embedding health probe
    scan: 1, // Serial file scanning
    "qdrant-setup": 1, // Serial collection setup / schema migration
    "codegraph-init": 1, // Serial enrichment beginRun / extraction-run init
    parse: chunkerPoolSize,
    git: gitChunkConcurrency,
    embed: pipelineConcurrency,
    qdrant: pipelineConcurrency,
    enrichment_prefetch: 1, // Parallel per-provider prefetch
    enrichGit: 1, // Background, single-threaded
    enrichApply: 1, // Streaming setPayload calls
    chunkChurn: gitChunkConcurrency,
    blame: gitChunkConcurrency, // Per-batch blame pass (cache misses spawn git blame)
  };
}
