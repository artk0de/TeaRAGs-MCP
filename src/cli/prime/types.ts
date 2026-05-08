import type { IndexMetrics, IndexStatus } from "../../core/api/public/dto/index.js";

/**
 * Successful prime data — index reachable, status fetched.
 * `metrics` is null when the project is not yet indexed (status !== "indexed").
 */
export interface PrimeData {
  path: string;
  status: IndexStatus;
  metrics: IndexMetrics | null;
  drift: string | null;
}

/**
 * Degraded outputs that exit the runPrime pipeline early without a full digest.
 * Each variant produces a short markdown placeholder via formatPrime.
 */
export type PrimeFailureReason = { kind: "path-not-found"; path: string } | { kind: "qdrant-cold"; path: string };
