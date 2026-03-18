/**
 * PipelineManager - Main coordinator for batched operations
 *
 * Orchestrates:
 * - BatchAccumulators for upsert and delete operations
 * - WorkerPool for bounded concurrent execution
 * - Backpressure management between producer and consumer
 *
 * Usage:
 *   const pipeline = new PipelineManager(config, handlers);
 *   await pipeline.start();
 *
 *   // Add items (returns false if backpressure active)
 *   pipeline.addUpsert(point);
 *   pipeline.addDelete(path);
 *
 *   // Wait for all work to complete
 *   await pipeline.flush();
 *   await pipeline.shutdown();
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { PipelineNotStartedError } from "../errors.js";
import { BatchAccumulator } from "./infra/batch-accumulator.js";
import { isDebug } from "./infra/runtime.js";
import { WorkerPool } from "./infra/worker-pool.js";
import type { Batch, BatchResult, DeleteItem, PipelineConfig, PipelineStats, UpsertItem, WorkItem } from "./types.js";

/**
 * Handlers for processing different operation types
 */
export interface PipelineHandlers {
  /** Process a batch of upsert operations */
  handleUpsertBatch: (batch: Batch<UpsertItem>) => Promise<void>;
  /** Process a batch of delete operations */
  handleDeleteBatch: (batch: Batch<DeleteItem>) => Promise<void>;
}

export class PipelineManager {
  private readonly config: PipelineConfig;
  private readonly handlers: PipelineHandlers;

  private readonly workerPool: WorkerPool;
  private readonly upsertAccumulator: BatchAccumulator<UpsertItem>;
  private readonly deleteAccumulator: BatchAccumulator<DeleteItem>;

  private isRunning = false;
  private pendingBatches: Promise<BatchResult>[] = [];
  private readonly stats = {
    itemsProcessed: 0,
    batchesProcessed: 0,
    errors: 0,
    startTime: 0,
  };

  constructor(handlers: PipelineHandlers, config?: Partial<PipelineConfig>) {
    const fallbackWorkerPool = { concurrency: 1, maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 5000 };
    const fallbackUpsert = { batchSize: 1024, flushTimeoutMs: 2000, maxQueueSize: 2 };
    const fallbackDelete = { batchSize: 500, flushTimeoutMs: 1000, maxQueueSize: 16 };

    this.config = {
      workerPool: { ...fallbackWorkerPool, ...config?.workerPool },
      deleteWorkerPool: { ...fallbackWorkerPool, concurrency: 8, ...config?.deleteWorkerPool },
      upsertAccumulator: { ...fallbackUpsert, ...config?.upsertAccumulator },
      deleteAccumulator: { ...fallbackDelete, ...config?.deleteAccumulator },
    };
    this.handlers = handlers;

    // Initialize worker pool
    this.workerPool = new WorkerPool(
      this.config.workerPool,
      (result) => {
        this.onBatchComplete(result);
      },
      (queueSize) => {
        this.onQueueChange(queueSize);
      },
    );

    // Initialize accumulators
    this.upsertAccumulator = new BatchAccumulator(this.config.upsertAccumulator, "upsert", (batch) => {
      this.submitBatch(batch, this.handlers.handleUpsertBatch);
    });

    this.deleteAccumulator = new BatchAccumulator(this.config.deleteAccumulator, "delete", (batch) => {
      this.submitBatch(batch, this.handlers.handleDeleteBatch);
    });
  }

  /**
   * Start the pipeline
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.stats.startTime = Date.now();

    if (isDebug()) {
      console.error(
        `[PipelineManager] Started with config: ` +
          `workers=${this.config.workerPool.concurrency}, ` +
          `upsertBatch=${this.config.upsertAccumulator.batchSize}, ` +
          `deleteBatch=${this.config.deleteAccumulator.batchSize}`,
      );
    }
  }

  /**
   * Add a point for upsert
   * @returns true if accepted, false if backpressure active
   */
  addUpsert(point: UpsertItem["point"]): boolean {
    if (!this.isRunning) {
      throw new PipelineNotStartedError("PipelineManager");
    }

    const item: UpsertItem = {
      type: "upsert",
      id: point.id,
      point,
    };

    return this.upsertAccumulator.add(item);
  }

  /**
   * Add multiple points for upsert
   * @returns number of items accepted
   */
  addUpsertMany(points: UpsertItem["point"][]): number {
    let accepted = 0;
    for (const point of points) {
      if (this.addUpsert(point)) {
        accepted++;
      } else {
        break;
      }
    }
    return accepted;
  }

  /**
   * Add a path for deletion
   * @returns true if accepted, false if backpressure active
   */
  addDelete(relativePath: string): boolean {
    if (!this.isRunning) {
      throw new PipelineNotStartedError("PipelineManager");
    }

    const item: DeleteItem = {
      type: "delete",
      id: relativePath,
      relativePath,
    };

    return this.deleteAccumulator.add(item);
  }

  /**
   * Add multiple paths for deletion
   * @returns number of items accepted
   */
  addDeleteMany(paths: string[]): number {
    let accepted = 0;
    for (const path of paths) {
      if (this.addDelete(path)) {
        accepted++;
      } else {
        break;
      }
    }
    return accepted;
  }

  /**
   * Flush all pending items and wait for completion
   */
  async flush(): Promise<void> {
    this.upsertAccumulator.drain();
    this.deleteAccumulator.drain();
    await this.workerPool.drain();
    await Promise.all(this.pendingBatches);
    this.pendingBatches = [];
  }

  /**
   * Gracefully shutdown the pipeline
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    await this.flush();
    await this.workerPool.shutdown();
    this.isRunning = false;

    if (isDebug()) {
      const stats = this.getStats();
      console.error(
        `[PipelineManager] Shutdown: ${stats.itemsProcessed} items, ` +
          `${stats.batchesProcessed} batches, ${stats.errors} errors ` +
          `in ${(stats.uptimeMs / 1000).toFixed(1)}s (${stats.throughput.toFixed(1)} items/s)`,
      );
    }
  }

  /**
   * Force shutdown (cancel pending work)
   */
  forceShutdown(): void {
    this.isRunning = false;
    this.upsertAccumulator.clear();
    this.deleteAccumulator.clear();
    this.workerPool.forceShutdown();
    this.pendingBatches = [];
  }

  /**
   * Get pipeline statistics
   */
  getStats(): PipelineStats {
    const poolStats = this.workerPool.getStats();
    const uptimeMs = this.stats.startTime > 0 ? Date.now() - this.stats.startTime : 0;

    return {
      itemsProcessed: this.stats.itemsProcessed,
      batchesProcessed: this.stats.batchesProcessed,
      errors: this.stats.errors,
      queueDepth: poolStats.queueDepth,
      avgBatchTimeMs: poolStats.avgTimeMs,
      throughput: uptimeMs > 0 ? (this.stats.itemsProcessed / uptimeMs) * 1000 : 0,
      uptimeMs,
    };
  }

  /**
   * Check if backpressure is active for upserts
   */
  isUpsertBackpressured(): boolean {
    return this.upsertAccumulator.isPausedState();
  }

  /**
   * Check if backpressure is active for deletes
   */
  isDeleteBackpressured(): boolean {
    return this.deleteAccumulator.isPausedState();
  }

  /**
   * Wait for backpressure to release
   * @param timeout Maximum time to wait (ms)
   * @returns true if released, false if timeout
   */
  async waitForBackpressure(timeout = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (this.isUpsertBackpressured() || this.isDeleteBackpressured()) {
      if (Date.now() - startTime > timeout) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return true;
  }

  private submitBatch<T extends WorkItem>(batch: Batch<T>, handler: (batch: Batch<T>) => Promise<void>): void {
    const promise = this.workerPool.submit(batch, handler);
    this.pendingBatches.push(promise);

    // Cleanup completed promises periodically
    if (this.pendingBatches.length > 100) {
      this.pendingBatches = this.pendingBatches.filter((p) => !this.isPromiseResolved(p));
    }
  }

  private onBatchComplete(result: BatchResult): void {
    this.stats.batchesProcessed++;
    this.stats.itemsProcessed += result.itemCount;

    if (!result.success) {
      this.stats.errors++;
    }
  }

  private onQueueChange(queueSize: number): void {
    const maxQueue = this.config.upsertAccumulator.maxQueueSize;

    if (queueSize >= maxQueue) {
      // Apply backpressure
      this.upsertAccumulator.pause();
      this.deleteAccumulator.pause();
    } else if (queueSize < maxQueue * 0.5) {
      // Release backpressure when queue is half empty
      this.upsertAccumulator.resume();
      this.deleteAccumulator.resume();
    }
  }

  private isPromiseResolved(promise: Promise<unknown>): boolean {
    // Check if promise is resolved by racing with a known resolved promise
    let resolved = false;
    Promise.race([promise.then(() => (resolved = true)), Promise.resolve()]).catch(() => {});
    return resolved;
  }
}

/**
 * Factory function to create a PipelineManager with Qdrant handlers
 */
export function createQdrantPipeline(
  qdrant: QdrantManager,
  collectionName: string,
  options?: {
    config?: Partial<PipelineConfig>;
    enableHybrid?: boolean;
  },
): PipelineManager {
  const handlers: PipelineHandlers = {
    handleUpsertBatch: async (batch) => {
      const points = batch.items.map((item) => ({
        id: item.point.id,
        vector: item.point.vector,
        payload: item.point.payload,
      }));

      if (options?.enableHybrid) {
        const hybridPoints = batch.items.map((item) => ({
          id: item.point.id,
          vector: item.point.vector,
          sparseVector: item.point.sparseVector || { indices: [], values: [] },
          payload: item.point.payload,
        }));
        await qdrant.addPointsWithSparse(collectionName, hybridPoints);
      } else {
        await qdrant.addPointsOptimized(collectionName, points, {
          wait: false,
          ordering: "weak",
        });
      }
    },

    handleDeleteBatch: async (batch) => {
      const paths = batch.items.map((item) => item.relativePath);
      await qdrant.deletePointsByPaths(collectionName, paths);
    },
  };

  return new PipelineManager(handlers, options?.config);
}
