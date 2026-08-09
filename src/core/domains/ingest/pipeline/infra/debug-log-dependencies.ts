/**
 * Bootstrap-injected dependencies of the pipeline debug logger.
 *
 * The logger is a module singleton constructed at import time — long before
 * config resolves — so its collaborators arrive later through
 * `initDebugLogger()`. Holding that mutable state here, behind readers that
 * already carry the fallback, means the sink and the formatter each take what
 * they need without either of them owning injection, and no caller has to
 * repeat the "config might not be available" dance.
 */

import type { PipelineConcurrencyLimits } from "./pipeline-stage-profiler.js";

let logsDir: string | null = null;
let configDumpFn: (() => Record<string, unknown>) | null = null;
let concurrencyFn: (() => PipelineConcurrencyLimits) | null = null;

/**
 * Initialize debug logger with injected dependencies (call once from bootstrap).
 * If not called, the logger still works but skips config dump header and concurrency stats.
 */
export function initDebugLogger(opts: {
  logsDir: string;
  getConfigDump: () => Record<string, unknown>;
  getConcurrency: () => PipelineConcurrencyLimits;
}): void {
  ({ logsDir, getConfigDump: configDumpFn, getConcurrency: concurrencyFn } = opts);
}

/** Directory log files are written to, or null when nothing was injected. */
export function readLogsDir(): string | null {
  return logsDir;
}

/** Resolved config snapshot for the session header; empty when unavailable. */
export function readConfigDump(): Record<string, unknown> {
  let dump: Record<string, unknown> = {};
  try {
    if (configDumpFn) {
      dump = configDumpFn();
    }
  } catch {
    // Config not available — fall back to empty dump
  }
  return dump;
}

/** Configured stage concurrency; falls back to the pipeline's own defaults. */
export function readConcurrencyLimits(): PipelineConcurrencyLimits {
  let pipelineConcurrency = 1;
  let chunkerPoolSize = 4;
  let gitChunkConcurrency = 10;
  try {
    if (concurrencyFn) {
      ({ pipelineConcurrency, chunkerPoolSize, gitChunkConcurrency } = concurrencyFn());
    }
  } catch {
    // Config not available — use defaults
  }
  return { pipelineConcurrency, chunkerPoolSize, gitChunkConcurrency };
}
