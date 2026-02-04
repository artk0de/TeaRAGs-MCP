/**
 * BatchAccumulator - Collects items into batches with backpressure support
 *
 * Features:
 * - Accumulates items until batch size is reached
 * - Automatic flush after timeout (partial batches)
 * - Backpressure when queue is full
 * - Thread-safe accumulation
 */

import { randomUUID } from "node:crypto";
import type {
  Batch,
  BatchAccumulatorConfig,
  BackpressureCallback,
  OperationType,
  WorkItem,
} from "./types.js";

/** Enable debug logging */
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

export class BatchAccumulator<T extends WorkItem> {
  private readonly config: BatchAccumulatorConfig;
  private readonly operationType: OperationType;
  private readonly onBatchReady: (batch: Batch<T>) => void;
  private readonly onBackpressure?: BackpressureCallback;

  private pendingItems: T[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isPaused = false;
  private batchCount = 0;

  constructor(
    config: BatchAccumulatorConfig,
    operationType: OperationType,
    onBatchReady: (batch: Batch<T>) => void,
    onBackpressure?: BackpressureCallback,
  ) {
    this.config = config;
    this.operationType = operationType;
    this.onBatchReady = onBatchReady;
    this.onBackpressure = onBackpressure;
  }

  /**
   * Add an item to the accumulator
   * @returns true if accepted, false if backpressure is active
   */
  add(item: T): boolean {
    if (this.isPaused) {
      return false;
    }

    this.pendingItems.push(item);
    this.startFlushTimer();

    // Check if batch is full
    if (this.pendingItems.length >= this.config.batchSize) {
      this.flush();
    }

    return true;
  }

  /**
   * Add multiple items at once
   * @returns number of items accepted (may be less than input if backpressure)
   */
  addMany(items: T[]): number {
    let accepted = 0;

    for (const item of items) {
      if (this.add(item)) {
        accepted++;
      } else {
        break; // Backpressure active
      }
    }

    return accepted;
  }

  /**
   * Force flush any pending items
   */
  flush(): void {
    this.clearFlushTimer();

    if (this.pendingItems.length === 0) {
      return;
    }

    const batch: Batch<T> = {
      id: `${this.operationType}-${++this.batchCount}-${randomUUID().slice(0, 8)}`,
      type: this.operationType,
      items: this.pendingItems,
      createdAt: Date.now(),
    };

    this.pendingItems = [];

    if (DEBUG) {
      console.error(
        `[BatchAccumulator] ${this.operationType}: flushing batch ${batch.id} with ${batch.items.length} items`,
      );
    }

    this.onBatchReady(batch);
  }

  /**
   * Apply backpressure - stop accepting new items
   */
  pause(): void {
    if (!this.isPaused) {
      this.isPaused = true;
      this.onBackpressure?.(true);

      if (DEBUG) {
        console.error(
          `[BatchAccumulator] ${this.operationType}: backpressure ACTIVE`,
        );
      }
    }
  }

  /**
   * Resume accepting items after backpressure
   */
  resume(): void {
    if (this.isPaused) {
      this.isPaused = false;
      this.onBackpressure?.(false);

      if (DEBUG) {
        console.error(
          `[BatchAccumulator] ${this.operationType}: backpressure RELEASED`,
        );
      }
    }
  }

  /**
   * Check if backpressure is active
   */
  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * Get number of pending items
   */
  getPendingCount(): number {
    return this.pendingItems.length;
  }

  /**
   * Drain all pending items and stop timers
   */
  drain(): void {
    this.flush();
    this.clearFlushTimer();
  }

  /**
   * Clear all pending items without flushing
   */
  clear(): void {
    this.pendingItems = [];
    this.clearFlushTimer();
  }

  private startFlushTimer(): void {
    if (this.flushTimer) {
      return; // Timer already running
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;

      const minBatch = this.config.minBatchSize;
      if (
        minBatch != null &&
        minBatch > 0 &&
        this.pendingItems.length < minBatch
      ) {
        // Below minimum — re-arm with shorter timeout, force flush on second fire
        if (this.pendingItems.length > 0) {
          this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
          }, this.config.flushTimeoutMs / 2);
        }
      } else {
        this.flush();
      }
    }, this.config.flushTimeoutMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
