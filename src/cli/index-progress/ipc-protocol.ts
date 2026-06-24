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
  | { type: "error"; message: string }
  | { type: "phase-done"; phase: string; elapsedMs: number };

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
        (m.level === "file" || m.level === "chunk") &&
        typeof m.applied === "number" &&
        typeof m.total === "number"
      );
    case "status":
      return typeof m.status === "object" && m.status !== null;
    case "done":
      return typeof m.result === "object" && m.result !== null;
    case "error":
      return typeof m.message === "string";
    case "phase-done":
      return typeof m.phase === "string" && typeof m.elapsedMs === "number";
    default:
      return false;
  }
}
