import type { IndexMetrics, IndexStatus } from "../../core/api/public/dto/index.js";
import type { UpdateStatus } from "../update-check/types.js";

/**
 * Successful prime data — index reachable, status fetched.
 * `metrics` is null when the project is not yet indexed (status !== "indexed").
 * `update` is null when the prime path did not request an update check
 *   (e.g. degraded path) or the field was never populated.
 */
export interface PrimeData {
  path: string;
  /** Registered alias for this project, null when no registry entry has a name. */
  projectName: string | null;
  status: IndexStatus;
  metrics: IndexMetrics | null;
  drift: string | null;
  update: UpdateStatus | null;
}

/**
 * Degraded outputs that exit the runPrime pipeline early without a full digest.
 * Each variant produces a short markdown placeholder via formatPrime.
 */
export type PrimeFailureReason = { kind: "path-not-found"; path: string } | { kind: "qdrant-cold"; path: string };
