import type { AutoUpdateTriggerOutcome } from "../../bootstrap/auto-update/trigger.js";
import type { CollectionEntry } from "../../core/api/public/index.js";
import type { UpdateStatus } from "../update-check/types.js";

/**
 * What `tea-rags prime` prints on success: the project digest resource text,
 * the metrics resource text under `--full`, and the CLI-only lines (package
 * update notice, auto-update verdict) the resources do not carry.
 */
export interface PrimeData {
  /** `tea-rags://project/<alias>/digest` text, as the server rendered it. */
  digest: string;
  /** `tea-rags://project/<alias>/metrics` text; absent unless `--full`. */
  metrics?: string;
  /** Registry entry backing the project — source of the auto-update config. */
  registry?: CollectionEntry | null;
  update: UpdateStatus | null;
  /**
   * Outcome of the auto-update trigger fired for this prime run (hpg2) —
   * verdict kind or "in-memory-debounced". Absent/null = trigger not fired:
   * no auto-update line at all.
   */
  autoUpdateOutcome?: AutoUpdateTriggerOutcome | null;
  /** Per-project auto-update log path, shown on failure lines. */
  autoUpdateLogPath?: string;
  /** Step a background client update refused (c2dr6) — printed in both modes until a manual `tea-rags update`. */
  clientUpdateHint?: string | null;
  /** `--agent`: print the digest alone — no update notice, auto-update status or refresh line. */
  agent?: boolean;
}

/**
 * Degraded outputs that exit the runPrime pipeline early without a digest.
 * Each variant produces a short markdown placeholder via formatPrime.
 */
export type PrimeFailureReason =
  | { kind: "path-not-found"; path: string }
  | { kind: "qdrant-cold"; path: string }
  /** No registry entry claims the path — there is no project alias to read a digest for. */
  | { kind: "not-registered"; path: string }
  /** Opening the in-process server failed for a reason other than a cold Qdrant — shown as-is. */
  | { kind: "status-failed"; path: string; message: string; code?: string; hint?: string };
