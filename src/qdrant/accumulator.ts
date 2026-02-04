/**
 * PointsAccumulator - Batch upsert pipeline for Qdrant
 *
 * Accumulates points in a buffer and flushes them in batches for optimal throughput.
 * Supports both dense-only and hybrid (dense + sparse) vectors.
 *
 * Features:
 * - Configurable buffer size (default: 100 points)
 * - Auto-flush by timer (default: 500ms)
 * - Auto-flush by size threshold
 * - Explicit flush() for final consistency
 * - Uses wait=false for intermediate batches (fire-and-forget)
 * - Uses wait=true for final flush (consistency guarantee)
 */

import type { QdrantManager, SparseVector } from "./client.js";

export interface DensePoint {
  id: string | number;
  vector: number[];
  payload?: Record<string, any>;
}

export interface HybridPoint extends DensePoint {
  sparseVector: SparseVector;
}

export interface AccumulatorConfig {
  /** Maximum points to accumulate before auto-flush (default: 100) */
  bufferSize: number;
  /** Auto-flush interval in ms (default: 500, 0 to disable) */
  flushIntervalMs: number;
  /** Qdrant ordering mode for intermediate batches (default: "weak") */
  ordering: "weak" | "medium" | "strong";
}

export interface AccumulatorStats {
  totalPointsFlushed: number;
  flushCount: number;
  lastFlushTime: number | null;
  pendingPoints: number;
}

const DEFAULT_CONFIG: AccumulatorConfig = {
  bufferSize: 100,
  flushIntervalMs: 500,
  ordering: "weak",
};

export class PointsAccumulator {
  private readonly qdrant: QdrantManager;
  private readonly collectionName: string;
  private readonly config: AccumulatorConfig;
  private readonly isHybrid: boolean;

  private buffer: (DensePoint | HybridPoint)[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private stats: AccumulatorStats = {
    totalPointsFlushed: 0,
    flushCount: 0,
    lastFlushTime: null,
    pendingPoints: 0,
  };

  // Track pending flush promises for cleanup
  private pendingFlushes: Promise<void>[] = [];

  constructor(
    qdrant: QdrantManager,
    collectionName: string,
    isHybrid: boolean = false,
    config: Partial<AccumulatorConfig> = {},
  ) {
    this.qdrant = qdrant;
    this.collectionName = collectionName;
    this.isHybrid = isHybrid;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Add points to the buffer. Triggers auto-flush when buffer is full.
   */
  async add(points: DensePoint[] | HybridPoint[]): Promise<void> {
    this.buffer.push(...points);
    this.stats.pendingPoints = this.buffer.length;

    // Start timer if not running and auto-flush enabled
    if (this.config.flushIntervalMs > 0 && !this.flushTimer) {
      this.startFlushTimer();
    }

    // Auto-flush if buffer exceeds threshold
    while (this.buffer.length >= this.config.bufferSize) {
      await this.flushBatch(false);
    }
  }

  /**
   * Flush all remaining points with wait=true for consistency.
   * Call this at the end of indexing operation.
   */
  async flush(): Promise<void> {
    this.stopFlushTimer();

    // Wait for any pending background flushes
    if (this.pendingFlushes.length > 0) {
      await Promise.all(this.pendingFlushes);
      this.pendingFlushes = [];
    }

    // Final flush with wait=true
    if (this.buffer.length > 0) {
      await this.flushBatch(true);
    }
  }

  /**
   * Get current statistics
   */
  getStats(): AccumulatorStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalPointsFlushed: 0,
      flushCount: 0,
      lastFlushTime: null,
      pendingPoints: this.buffer.length,
    };
  }

  /**
   * Dispose of the accumulator, flushing any remaining points
   */
  async dispose(): Promise<void> {
    await this.flush();
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;

    this.flushTimer = setTimeout(async () => {
      this.flushTimer = null;
      if (this.buffer.length > 0) {
        // Timer-triggered flush uses wait=false (non-blocking)
        const flushPromise = this.flushBatch(false);
        this.pendingFlushes.push(flushPromise);
        flushPromise.finally(() => {
          const idx = this.pendingFlushes.indexOf(flushPromise);
          if (idx >= 0) this.pendingFlushes.splice(idx, 1);
        });
      }
      // Restart timer if buffer still has items
      if (this.buffer.length > 0) {
        this.startFlushTimer();
      }
    }, this.config.flushIntervalMs);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async flushBatch(waitForResult: boolean): Promise<void> {
    const batchSize = Math.min(this.buffer.length, this.config.bufferSize);
    if (batchSize === 0) return;

    const batch = this.buffer.splice(0, batchSize);
    this.stats.pendingPoints = this.buffer.length;

    try {
      if (this.isHybrid) {
        await this.qdrant.addPointsWithSparseOptimized(
          this.collectionName,
          batch as HybridPoint[],
          {
            wait: waitForResult,
            ordering: this.config.ordering,
          },
        );
      } else {
        await this.qdrant.addPointsOptimized(
          this.collectionName,
          batch as DensePoint[],
          {
            wait: waitForResult,
            ordering: this.config.ordering,
          },
        );
      }

      this.stats.totalPointsFlushed += batch.length;
      this.stats.flushCount++;
      this.stats.lastFlushTime = Date.now();
    } catch (error) {
      // On error, put points back in buffer for retry
      this.buffer.unshift(...batch);
      this.stats.pendingPoints = this.buffer.length;
      throw error;
    }
  }
}

/**
 * Factory function to create accumulator with environment-based config.
 *
 * Environment variables:
 * - QDRANT_UPSERT_BATCH_SIZE: Points per Qdrant upsert batch (default: 100)
 *   Legacy: CODE_BATCH_SIZE (deprecated, use QDRANT_UPSERT_BATCH_SIZE)
 * - QDRANT_FLUSH_INTERVAL_MS: Auto-flush interval (default: 500, 0 to disable)
 * - QDRANT_BATCH_ORDERING: Ordering mode "weak"|"medium"|"strong" (default: "weak")
 */
export function createAccumulator(
  qdrant: QdrantManager,
  collectionName: string,
  isHybrid: boolean = false,
): PointsAccumulator {
  const config: Partial<AccumulatorConfig> = {
    // QDRANT_UPSERT_BATCH_SIZE is canonical, CODE_BATCH_SIZE is deprecated fallback
    bufferSize: parseInt(
      process.env.QDRANT_UPSERT_BATCH_SIZE || process.env.CODE_BATCH_SIZE || "100",
      10,
    ),
    flushIntervalMs: parseInt(
      process.env.QDRANT_FLUSH_INTERVAL_MS || "500",
      10,
    ),
    ordering: (process.env.QDRANT_BATCH_ORDERING as AccumulatorConfig["ordering"]) || "weak",
  };

  return new PointsAccumulator(qdrant, collectionName, isHybrid, config);
}