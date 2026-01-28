/**
 * WorkerPool - Bounded concurrency executor with retry support
 *
 * Features:
 * - Fixed number of concurrent workers
 * - Exponential backoff retry on failures
 * - Queue management with backpressure signaling
 * - Graceful shutdown
 */

import type {
  Batch,
  BatchCompletionCallback,
  BatchHandler,
  BatchResult,
  WorkerPoolConfig,
  WorkItem,
} from "./types.js";

/** Enable debug logging */
const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";

interface QueuedBatch<T extends WorkItem> {
  batch: Batch<T>;
  handler: BatchHandler<T>;
  retryCount: number;
  resolve: (result: BatchResult) => void;
  reject: (error: Error) => void;
}

export class WorkerPool {
  private readonly config: WorkerPoolConfig;
  private readonly onCompletion?: BatchCompletionCallback;
  private readonly onQueueChange?: (queueSize: number) => void;

  private queue: QueuedBatch<any>[] = [];
  private activeWorkers = 0;
  private isShuttingDown = false;
  private totalProcessed = 0;
  private totalErrors = 0;
  private totalTimeMs = 0;
  private startTime: number;

  constructor(
    config: WorkerPoolConfig,
    onCompletion?: BatchCompletionCallback,
    onQueueChange?: (queueSize: number) => void,
  ) {
    this.config = config;
    this.onCompletion = onCompletion;
    this.onQueueChange = onQueueChange;
    this.startTime = Date.now();
  }

  /**
   * Submit a batch for processing
   * @returns Promise that resolves when batch is processed
   */
  submit<T extends WorkItem>(
    batch: Batch<T>,
    handler: BatchHandler<T>,
  ): Promise<BatchResult> {
    if (this.isShuttingDown) {
      return Promise.reject(new Error("WorkerPool is shutting down"));
    }

    return new Promise((resolve, reject) => {
      const queuedBatch: QueuedBatch<T> = {
        batch,
        handler,
        retryCount: 0,
        resolve,
        reject,
      };

      this.queue.push(queuedBatch);
      this.notifyQueueChange();
      this.tryProcessNext();
    });
  }

  /**
   * Get current queue depth
   */
  getQueueDepth(): number {
    return this.queue.length;
  }

  /**
   * Get number of active workers
   */
  getActiveWorkers(): number {
    return this.activeWorkers;
  }

  /**
   * Check if pool is at capacity
   */
  isAtCapacity(): boolean {
    return this.activeWorkers >= this.config.concurrency;
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    processed: number;
    errors: number;
    avgTimeMs: number;
    queueDepth: number;
    activeWorkers: number;
    throughput: number;
  } {
    const uptimeMs = Date.now() - this.startTime;
    return {
      processed: this.totalProcessed,
      errors: this.totalErrors,
      avgTimeMs:
        this.totalProcessed > 0 ? this.totalTimeMs / this.totalProcessed : 0,
      queueDepth: this.queue.length,
      activeWorkers: this.activeWorkers,
      throughput: uptimeMs > 0 ? (this.totalProcessed / uptimeMs) * 1000 : 0,
    };
  }

  /**
   * Wait for all queued batches to complete
   */
  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.activeWorkers > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /**
   * Gracefully shutdown the pool
   * Waits for in-progress work to complete
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    await this.drain();

    if (DEBUG) {
      const stats = this.getStats();
      console.error(
        `[WorkerPool] Shutdown complete: processed=${stats.processed}, errors=${stats.errors}, ` +
          `avgTime=${stats.avgTimeMs.toFixed(1)}ms`,
      );
    }
  }

  /**
   * Force immediate shutdown (cancels pending work)
   */
  forceShutdown(): void {
    this.isShuttingDown = true;

    // Resolve all pending batches with cancelled status (don't reject to avoid unhandled rejections)
    for (const queuedBatch of this.queue) {
      const result: BatchResult = {
        batchId: queuedBatch.batch.id,
        type: queuedBatch.batch.type,
        success: false,
        itemCount: queuedBatch.batch.items.length,
        durationMs: 0,
        error: "WorkerPool force shutdown",
      };
      this.totalErrors++;
      this.onCompletion?.(result);
      queuedBatch.resolve(result);
    }
    this.queue = [];
    this.notifyQueueChange();
  }

  private tryProcessNext(): void {
    if (this.isShuttingDown) {
      return;
    }

    if (this.activeWorkers >= this.config.concurrency) {
      return; // At capacity
    }

    const queuedBatch = this.queue.shift();
    if (!queuedBatch) {
      return; // Queue empty
    }

    this.notifyQueueChange();
    this.activeWorkers++;
    this.processWithRetry(queuedBatch);
  }

  private async processWithRetry<T extends WorkItem>(
    queuedBatch: QueuedBatch<T>,
  ): Promise<void> {
    const { batch, handler, resolve } = queuedBatch;
    const startTime = Date.now();

    try {
      await handler(batch);

      const durationMs = Date.now() - startTime;
      this.totalProcessed++;
      this.totalTimeMs += durationMs;

      const result: BatchResult = {
        batchId: batch.id,
        type: batch.type,
        success: true,
        itemCount: batch.items.length,
        durationMs,
        retryCount: queuedBatch.retryCount,
      };

      if (DEBUG) {
        console.error(
          `[WorkerPool] Batch ${batch.id} completed in ${durationMs}ms ` +
            `(${batch.items.length} items, retry=${queuedBatch.retryCount})`,
        );
      }

      this.onCompletion?.(result);
      resolve(result);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      if (queuedBatch.retryCount < this.config.maxRetries) {
        // Retry with exponential backoff
        queuedBatch.retryCount++;
        const delay = this.calculateBackoff(queuedBatch.retryCount);

        if (DEBUG) {
          console.error(
            `[WorkerPool] Batch ${batch.id} failed (attempt ${queuedBatch.retryCount}/${this.config.maxRetries}), ` +
              `retrying in ${delay}ms: ${errorMessage}`,
          );
        }

        setTimeout(() => {
          this.queue.unshift(queuedBatch); // Add to front of queue
          this.notifyQueueChange();
          this.tryProcessNext();
        }, delay);
      } else {
        // Max retries exceeded
        this.totalErrors++;

        const durationMs = Date.now() - startTime;
        const result: BatchResult = {
          batchId: batch.id,
          type: batch.type,
          success: false,
          itemCount: batch.items.length,
          durationMs,
          error: errorMessage,
          retryCount: queuedBatch.retryCount,
        };

        console.error(
          `[WorkerPool] Batch ${batch.id} failed after ${queuedBatch.retryCount} retries: ${errorMessage}`,
        );

        this.onCompletion?.(result);
        resolve(result); // Resolve with failure result (don't reject)
      }
    } finally {
      this.activeWorkers--;
      this.tryProcessNext();
    }
  }

  private calculateBackoff(retryCount: number): number {
    // Exponential backoff with jitter
    const baseDelay =
      this.config.retryBaseDelayMs * Math.pow(2, retryCount - 1);
    const jitter = Math.random() * 0.3 * baseDelay; // 0-30% jitter
    return Math.min(baseDelay + jitter, this.config.retryMaxDelayMs);
  }

  private notifyQueueChange(): void {
    this.onQueueChange?.(this.queue.length);
  }
}
