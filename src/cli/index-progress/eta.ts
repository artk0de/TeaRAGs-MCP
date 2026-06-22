/**
 * Enrichment ETA estimation from the live in-process progress stream.
 *
 * Enrichment markers are terminal-only (no persisted live numerator), so a real
 * ETA can only come from the per-batch progress events emitted by the indexing
 * worker. `EnrichmentEtaTracker` aggregates the latest `applied`/`total` per
 * `(provider, level)` and extrapolates remaining time from observed throughput.
 */

import type { EnrichmentProgressEvent } from "../../core/api/public/index.js";

/**
 * Seconds until completion given cumulative units applied over an elapsed
 * window. Returns null when throughput cannot yet be estimated (no work applied
 * or zero elapsed time). Never negative — an over-count clamps to 0.
 */
export function computeEtaSeconds(applied: number, total: number, elapsedMs: number): number | null {
  if (applied <= 0 || elapsedMs <= 0) return null;
  const remaining = Math.max(0, total - applied);
  const ratePerMs = applied / elapsedMs;
  return remaining / ratePerMs / 1000;
}

/** Aggregates enrichment progress across providers/levels into a single ETA. */
export class EnrichmentEtaTracker {
  private readonly latest = new Map<string, { applied: number; total: number }>();

  constructor(private readonly startMs: number) {}

  record(event: EnrichmentProgressEvent, nowMs: number): void {
    void nowMs;
    this.latest.set(`${event.providerKey}:${event.level}`, { applied: event.applied, total: event.total });
  }

  etaSeconds(nowMs: number): number | null {
    if (this.latest.size === 0) return null;
    let applied = 0;
    let total = 0;
    for (const u of this.latest.values()) {
      applied += u.applied;
      total += u.total;
    }
    return computeEtaSeconds(applied, total, nowMs - this.startMs);
  }
}
