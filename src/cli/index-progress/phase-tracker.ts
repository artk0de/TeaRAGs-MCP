/**
 * Timing primitives for per-phase ETA estimation and overall index wall-clock.
 *
 * All timestamps are injected (startMs / nowMs params) — this module never
 * calls Date.now() internally.
 */

/** Format a duration in ms: sub-second → "Nms", otherwise "N.Ns". */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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

interface PhaseState {
  firstSeenMs: number;
  applied: number;
  total: number;
}

/**
 * Tracks per-phase progress and estimates remaining time for each phase
 * independently. Phase wall-clock starts at the first `record()` call for
 * that phase.
 */
export class PhaseProgressTracker {
  private readonly phases = new Map<string, PhaseState>();

  constructor(_startMs: number) {}

  record(phaseKey: string, applied: number, total: number, nowMs: number): void {
    const existing = this.phases.get(phaseKey);
    if (existing === undefined) {
      this.phases.set(phaseKey, { firstSeenMs: nowMs, applied, total });
    } else {
      existing.applied = applied;
      existing.total = total;
    }
  }

  etaSeconds(phaseKey: string, nowMs: number): number | null {
    const state = this.phases.get(phaseKey);
    if (state === undefined) return null;
    const elapsed = nowMs - state.firstSeenMs;
    return computeEtaSeconds(state.applied, state.total, elapsed);
  }

  /** Wall-clock of THIS phase: nowMs − first-record-time for the phase. */
  elapsedMs(phaseKey: string, nowMs: number): number {
    const state = this.phases.get(phaseKey);
    if (state === undefined) return 0;
    return nowMs - state.firstSeenMs;
  }

  /**
   * Aggregate ETA across all recorded phases: sums applied/total, uses
   * the earliest firstSeenMs as the elapsed window start.
   * Returns null when no phases recorded or throughput cannot be estimated.
   */
  aggregateEtaSeconds(nowMs: number): number | null {
    if (this.phases.size === 0) return null;
    let applied = 0;
    let total = 0;
    let earliestMs = Infinity;
    for (const state of this.phases.values()) {
      applied += state.applied;
      total += state.total;
      if (state.firstSeenMs < earliestMs) earliestMs = state.firstSeenMs;
    }
    return computeEtaSeconds(applied, total, nowMs - earliestMs);
  }
}

/**
 * Single wall-clock from index start to finish.
 * NEVER a sum of phase elapsed times.
 */
export class OverallTimer {
  private stoppedAt: number | undefined;

  constructor(private readonly startMs: number) {}

  stop(nowMs: number): void {
    this.stoppedAt = nowMs;
  }

  /** start → stop (or → nowMs if not yet stopped; 0 if not stopped and nowMs not provided). */
  elapsedMs(nowMs?: number): number {
    if (this.stoppedAt !== undefined) return this.stoppedAt - this.startMs;
    if (nowMs !== undefined) return nowMs - this.startMs;
    return 0;
  }
}
