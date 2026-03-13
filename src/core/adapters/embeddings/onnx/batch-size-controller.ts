import {
  MIN_BATCH_SIZE,
  MIN_RECOMMENDED_BATCH_SIZE,
  ROLLING_WINDOW,
  RUNTIME_PRESSURE_THRESHOLD,
  RUNTIME_STABLE_THRESHOLD,
} from "./constants.js";

/**
 * Adaptive GPU batch size controller.
 *
 * Tracks per-text latency via rolling average and adjusts batch size:
 * - Halves on pressure (msPerText > rollingAvg * RUNTIME_PRESSURE_THRESHOLD)
 * - Doubles on stability (msPerText < rollingAvg * RUNTIME_STABLE_THRESHOLD)
 * - Bounded by [minSize, calibratedSize]
 */
export class BatchSizeController {
  private readonly calibratedSize: number;
  private readonly minSize: number;
  private current: number;
  private readonly history: number[] = []; // msPerText values

  constructor(calibratedSize: number, minSize = MIN_BATCH_SIZE) {
    this.calibratedSize = calibratedSize;
    this.minSize = minSize;
    this.current = calibratedSize;
  }

  /** Report a completed sub-batch inference */
  report(durationMs: number, batchSize: number): void {
    const msPerText = durationMs / Math.max(batchSize, 1);
    this.history.push(msPerText);
    if (this.history.length > ROLLING_WINDOW) {
      this.history.shift();
    }

    // Don't adjust until we have enough data
    if (this.history.length < ROLLING_WINDOW) return;

    const avg = this.history.reduce((s, v) => s + v, 0) / this.history.length;

    if (msPerText > avg * RUNTIME_PRESSURE_THRESHOLD) {
      // Pressure detected — halve
      this.current = Math.max(this.minSize, Math.floor(this.current / 2));
    } else if (msPerText < avg * RUNTIME_STABLE_THRESHOLD) {
      // Stable — try to grow
      this.current = Math.min(this.calibratedSize, this.current * 2);
    }
  }

  /** Current internal GPU batch size */
  currentBatchSize(): number {
    return this.current;
  }

  /** Recommended pipeline batch size: max(32, calibrated * 2) */
  recommendedPipelineBatchSize(): number {
    return Math.max(MIN_RECOMMENDED_BATCH_SIZE, this.calibratedSize * 2);
  }
}
