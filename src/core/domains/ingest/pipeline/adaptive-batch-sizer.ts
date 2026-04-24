import { QdrantOptimizationInProgressError } from "../../../adapters/qdrant/errors.js";

export interface AdaptiveBatchSizerConfig {
  /** Starting batch size — also the cap the sizer recovers back to. */
  initial: number;
  /** Minimum batch size — the floor when halved too many times. */
  min: number;
  /** Number of consecutive successes required to double back up. */
  recoveryThreshold: number;
}

/**
 * Adaptively shrinks and recovers the Qdrant upsert batch size in response
 * to yellow-status signals (QdrantOptimizationInProgressError).
 *
 * On yellow failure: halve current size, floored at config.min.
 * On success: increment consecutive-success counter; on reaching
 * config.recoveryThreshold, double current size (capped at config.initial)
 * and reset the counter.
 * Non-yellow errors are ignored — the sizer only reacts to yellow.
 *
 * Part of reindex-resilience plan Phase 4.1. Phase 4.2 wires this into
 * ChunkPipeline's upsert loop.
 */
export class AdaptiveBatchSizer {
  private size: number;
  private consecutiveSuccesses = 0;

  constructor(private readonly config: AdaptiveBatchSizerConfig) {
    this.size = config.initial;
  }

  current(): number {
    return this.size;
  }

  onSuccess(): void {
    this.consecutiveSuccesses++;
    if (this.consecutiveSuccesses >= this.config.recoveryThreshold && this.size < this.config.initial) {
      this.size = Math.min(this.config.initial, this.size * 2);
      this.consecutiveSuccesses = 0;
    }
  }

  onFailure(error: unknown): void {
    if (!(error instanceof QdrantOptimizationInProgressError)) return;
    this.size = Math.max(this.config.min, Math.floor(this.size / 2));
    this.consecutiveSuccesses = 0;
  }
}
