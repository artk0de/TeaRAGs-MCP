/**
 * String shapes of the pipeline debug log: timestamps, durations, the session
 * header, and the two blocks the summary is assembled from.
 *
 * Split out of `debug-logger.ts` because layout is the part a reader tunes —
 * column widths, what the table shows, how a duration reads — and it should be
 * changeable without going anywhere near the code that decides when to log or
 * opens the file. Everything here is a pure function of its arguments.
 */

import {
  PIPELINE_STAGE_ORDER,
  type PipelineStage,
  type PipelineStageProfileSummary,
} from "./pipeline-stage-profiler.js";
import type { FileIngestRecord } from "./slow-file-tracker.js";

/** Filesystem-safe local timestamp: 2026-03-06T01-23-45 */
export function localTimestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
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

/** Session-relative stamp that prefixes every log line: `+   3.041s`. */
export function formatElapsed(elapsedMs: number): string {
  const sec = Math.floor(elapsedMs / 1000);
  const ms = elapsedMs % 1000;
  return `+${sec.toString().padStart(4, " ")}.${ms.toString().padStart(3, "0")}s`;
}

/** Banner written once per log file: resolved config plus derived thresholds. */
export function renderSessionHeader(configDump: Record<string, unknown>): string {
  // Format config dump as aligned key=value pairs
  const dumpEntries = Object.entries(configDump);
  const maxKeyLen = dumpEntries.length > 0 ? Math.max(...dumpEntries.map(([k]) => k.length)) : 0;
  const configLines = dumpEntries.map(([k, v]) => `  ${k.padEnd(maxKeyLen)} = ${String(v)}`).join("\n");

  // Derive concurrency stats
  const concurrency = (configDump["ingest.tune.pipelineConcurrency"] as number | undefined) ?? 1;

  return `
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
`;
}

/** Everything the STAGE PROFILING table needs; all of it already measured. */
export interface StageProfilingBlockInput {
  stages: PipelineStageProfileSummary;
  /** Sum of cumulative stage time — the table's TOTAL row. */
  stageTotalMs: number;
  /** Pipeline uptime, the denominator for the wall% column. */
  pipelineWallMs: number;
  concurrency: Record<PipelineStage, number>;
}

/**
 * Render the STAGE PROFILING table: cumulative vs wall time per stage, plus the
 * `~added` estimate of what each stage cost after concurrency is accounted for.
 */
export function renderStageProfilingBlock({
  stages,
  stageTotalMs,
  pipelineWallMs,
  concurrency,
}: StageProfilingBlockInput): string {
  // Column widths
  const W = { stage: 11, cum: 10, cpu: 6, wall: 10, wallP: 6, added: 8, calls: 6 };

  let stageBlock = "\nSTAGE PROFILING:\n";
  stageBlock += `  ${"stage".padEnd(W.stage)}  ${"cumul.".padStart(W.cum)}  ${"cpu%".padStart(W.cpu)}  ${"wall".padStart(W.wall)}  ${"wall%".padStart(W.wallP)}  ${"~added".padStart(W.added)}  ${"calls".padStart(W.calls)}\n`;
  stageBlock += `  ${"-".repeat(W.stage)}  ${"-".repeat(W.cum)}  ${"-".repeat(W.cpu)}  ${"-".repeat(W.wall)}  ${"-".repeat(W.wallP)}  ${"-".repeat(W.added)}  ${"-".repeat(W.calls)}\n`;

  let totalAddedMs = 0;
  for (const stage of PIPELINE_STAGE_ORDER) {
    const data = stages[stage];
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

  return stageBlock;
}

/** Render the slowest-files block, or nothing at all when none were tracked. */
export function renderSlowFilesBlock(slowFiles: readonly FileIngestRecord[]): string {
  if (slowFiles.length === 0) return "";
  return `\nSLOW_FILES_TOP_${slowFiles.length}:\n${JSON.stringify(slowFiles, null, 2)}\n`;
}
