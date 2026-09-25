/**
 * IPC message protocol between the foreground `index-codebase` supervisor and
 * the detached worker child. Messages cross a Node `fork` IPC channel as
 * structured-cloned plain objects, so `message` handlers receive `unknown` —
 * `isWorkerMessage` narrows before use.
 */

import type { EnrichmentProgressEvent, IndexStatus } from "../../core/api/public/index.js";

export type WorkerMessage =
  | {
      type: "embedding";
      phase: string;
      percentage: number;
      current: number;
      total: number;
      throughput?: number;
      /** False while `total` (chunksQueued) is still growing → render indeterminate. */
      totalFinal?: boolean;
    }
  | ({ type: "enrichment" } & EnrichmentProgressEvent)
  | { type: "status"; status: IndexStatus }
  | { type: "done"; result: EnrichmentOutcome }
  | {
      type: "error";
      message: string;
      /** Typed error code (TeaRagsError.code) when the fatal was typed; drives the --json error object. */
      code?: string;
      /** Typed error hint (TeaRagsError.hint): what to DO about the fatal, which the message alone does not say. */
      hint?: string;
    }
  | { type: "phase-done"; phase: string; elapsedMs: number }
  | {
      type: "qdrant-state";
      /**
       * Embedded-daemon readiness while the worker waits before indexing:
       * starting/recovering tick while the HTTP port is not bound yet
       * (shard recovery after a restart can take minutes); ready is the
       * terminal event that freezes the renderer's state line (2nfdm).
       */
      state: "starting" | "recovering" | "ready";
      /** Wall-clock wait so far (ms). */
      elapsedMs: number;
    }
  | ({ type: "embedding-state" } & EmbeddingRecoveryWaitState)
  | {
      type: "turbo-migration";
      /** Collection whose quantized vectors the background optimizer is rebuilding. */
      collection: string;
      /** start = optimizer pass began; done = settled to green; background = still optimizing at the poll cap. */
      stage: "start" | "done" | "background";
      /** Migration wall-clock so far — set on the terminal done/background events. */
      elapsedMs?: number;
    };

/**
 * Wait for an unreachable embedding provider (EMBEDDING_TUNE_UNAVAILABLE_RETRY_*),
 * as the worker reports it: `waiting` before each backoff pause, `recovered` as
 * the terminal event that freezes the renderer's state line. Giving up arrives
 * as an `error` (bd tea-rags-mcp-umatc). `elapsedMs` is the wall-clock wait so
 * far, `budgetMs` the configured ceiling on it.
 */
export type EmbeddingRecoveryWaitState =
  | { state: "waiting"; url: string; elapsedMs: number; budgetMs: number }
  | { state: "recovered"; url: string; elapsedMs: number };

/** Final enrichment outcome reported by the worker (drives exit code in --wait). */
export interface EnrichmentOutcome {
  /** Provider keys whose terminal marker was `failed`. */
  failed: string[];
  /** Provider keys whose terminal marker was `degraded`. */
  degraded: string[];
}

export function isWorkerMessage(value: unknown): value is WorkerMessage {
  if (value === null || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case "embedding":
      return (
        typeof m.phase === "string" &&
        typeof m.percentage === "number" &&
        typeof m.current === "number" &&
        typeof m.total === "number"
      );
    case "enrichment":
      return (
        typeof m.providerKey === "string" &&
        (m.level === "file" || m.level === "chunk" || m.level === "symbols") &&
        typeof m.applied === "number" &&
        typeof m.total === "number"
      );
    case "status":
      return typeof m.status === "object" && m.status !== null;
    case "done":
      return typeof m.result === "object" && m.result !== null;
    case "error":
      return (
        typeof m.message === "string" &&
        (m.code === undefined || typeof m.code === "string") &&
        (m.hint === undefined || typeof m.hint === "string")
      );
    case "phase-done":
      return typeof m.phase === "string" && typeof m.elapsedMs === "number";
    case "qdrant-state":
      return (
        (m.state === "starting" || m.state === "recovering" || m.state === "ready") && typeof m.elapsedMs === "number"
      );
    case "embedding-state":
      if (typeof m.url !== "string" || typeof m.elapsedMs !== "number") return false;
      if (m.state === "recovered") return true;
      return m.state === "waiting" && typeof m.budgetMs === "number";
    case "turbo-migration":
      return (
        typeof m.collection === "string" && (m.stage === "start" || m.stage === "done" || m.stage === "background")
      );
    default:
      return false;
  }
}
