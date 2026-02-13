/**
 * Tests for WorkerPool
 *
 * Coverage:
 * - Basic batch processing
 * - Bounded concurrency
 * - Retry with exponential backoff
 * - Graceful and force shutdown
 * - Statistics
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerPool } from "./worker-pool.js";
import type {
  Batch,
  BatchResult,
  UpsertItem,
  WorkerPoolConfig,
} from "./types.js";

describe("WorkerPool", () => {
  let pool: WorkerPool;
  let config: WorkerPoolConfig;

  beforeEach(() => {
    vi.useFakeTimers();

    config = {
      concurrency: 2,
      maxRetries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 1000,
    };

    pool = new WorkerPool(config);
  });

  afterEach(async () => {
    pool.forceShutdown();
    vi.useRealTimers();
  });

  // Helper to create test batch
  function createBatch(id: string, itemCount = 5): Batch<UpsertItem> {
    return {
      id,
      type: "upsert",
      items: Array.from({ length: itemCount }, (_, i) => ({
        type: "upsert" as const,
        id: `item-${i}`,
        point: {
          id: `item-${i}`,
          vector: [1, 2, 3],
          payload: { index: i },
        },
      })),
      createdAt: Date.now(),
    };
  }

  describe("Basic processing", () => {
    it("should process a single batch", async () => {
      const batch = createBatch("batch-1");
      const handler = vi.fn().mockResolvedValue(undefined);

      const resultPromise = pool.submit(batch, handler);
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(handler).toHaveBeenCalledWith(batch);
      expect(result.success).toBe(true);
      expect(result.batchId).toBe("batch-1");
      expect(result.itemCount).toBe(5);
    });

    it("should process multiple batches sequentially if only one worker", async () => {
      const singleWorkerPool = new WorkerPool({ ...config, concurrency: 1 });

      const execOrder: string[] = [];
      const handler = vi
        .fn()
        .mockImplementation(async (b: Batch<UpsertItem>) => {
          execOrder.push(b.id);
        });

      const p1 = singleWorkerPool.submit(createBatch("batch-1"), handler);
      const p2 = singleWorkerPool.submit(createBatch("batch-2"), handler);

      await vi.runAllTimersAsync();
      await Promise.all([p1, p2]);

      expect(execOrder).toEqual(["batch-1", "batch-2"]);
      singleWorkerPool.forceShutdown();
    });

    it("should track batch duration", async () => {
      vi.useRealTimers();
      const realPool = new WorkerPool(config);

      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });

      const result = await realPool.submit(createBatch("batch-1"), handler);

      expect(result.durationMs).toBeGreaterThanOrEqual(30);
      expect(result.durationMs).toBeLessThan(2000);
      realPool.forceShutdown();
    });
  });

  describe("Bounded concurrency", () => {
    it("should respect concurrency limit", async () => {
      vi.useRealTimers();
      const realPool = new WorkerPool({ ...config, concurrency: 2 });

      let concurrentCount = 0;
      let maxConcurrent = 0;

      const handler = vi.fn().mockImplementation(async () => {
        concurrentCount++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCount);
        await new Promise((r) => setTimeout(r, 50));
        concurrentCount--;
      });

      const promises = [
        realPool.submit(createBatch("batch-1"), handler),
        realPool.submit(createBatch("batch-2"), handler),
        realPool.submit(createBatch("batch-3"), handler),
        realPool.submit(createBatch("batch-4"), handler),
      ];

      await Promise.all(promises);

      expect(maxConcurrent).toBe(2);
      realPool.forceShutdown();
    });

    it("should report queue depth correctly", () => {
      const handler = vi.fn().mockImplementation(() => new Promise(() => {})); // Never resolves

      pool.submit(createBatch("batch-1"), handler);
      pool.submit(createBatch("batch-2"), handler);
      pool.submit(createBatch("batch-3"), handler);
      pool.submit(createBatch("batch-4"), handler);

      // 2 active, 2 queued
      expect(pool.getQueueDepth()).toBe(2);
      expect(pool.getActiveWorkers()).toBe(2);
      expect(pool.isAtCapacity()).toBe(true);
    });

    it("should notify on queue changes", async () => {
      const queueChanges: number[] = [];
      const notifyingPool = new WorkerPool(config, undefined, (size) =>
        queueChanges.push(size),
      );

      const handler = vi.fn().mockResolvedValue(undefined);

      const p1 = notifyingPool.submit(createBatch("batch-1"), handler);
      const p2 = notifyingPool.submit(createBatch("batch-2"), handler);
      const p3 = notifyingPool.submit(createBatch("batch-3"), handler);

      await vi.runAllTimersAsync();
      await Promise.all([p1, p2, p3]);

      // Should have queue changes as batches are added and processed
      expect(queueChanges.length).toBeGreaterThan(0);
      notifyingPool.forceShutdown();
    });
  });

  describe("Retry with backoff", () => {
    it("should retry failed batches", async () => {
      let attempts = 0;
      const handler = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`);
        }
      });

      const resultPromise = pool.submit(createBatch("batch-1"), handler);

      // Advance through retries
      await vi.advanceTimersByTimeAsync(100); // First retry
      await vi.advanceTimersByTimeAsync(200); // Second retry
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(attempts).toBe(3);
      expect(result.success).toBe(true);
      expect(result.retryCount).toBe(2);
    });

    it("should fail after max retries exceeded", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Always fails"));

      const resultPromise = pool.submit(createBatch("batch-1"), handler);

      // Advance through all retries
      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }
      await vi.runAllTimersAsync();

      const result = await resultPromise;

      expect(handler).toHaveBeenCalledTimes(4); // Initial + 3 retries
      expect(result.success).toBe(false);
      expect(result.error).toBe("Always fails");
      expect(result.retryCount).toBe(3);
    });

    it("should use exponential backoff", async () => {
      vi.useRealTimers();
      const retryPool = new WorkerPool({
        ...config,
        retryBaseDelayMs: 50,
        maxRetries: 2,
      });

      const timestamps: number[] = [];
      const handler = vi.fn().mockImplementation(async () => {
        timestamps.push(Date.now());
        if (timestamps.length < 3) {
          throw new Error("Fail");
        }
      });

      await retryPool.submit(createBatch("batch-1"), handler);

      // Check delays are increasing (with some tolerance for execution time)
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];

      expect(delay1).toBeGreaterThanOrEqual(30); // ~50ms base (CI tolerance)
      expect(delay2).toBeGreaterThan(delay1); // Second retry must be longer (exponential)
      retryPool.forceShutdown();
    });
  });

  describe("Completion callback", () => {
    it("should invoke callback on success", async () => {
      const callback = vi.fn();
      const callbackPool = new WorkerPool(config, callback);

      const handler = vi.fn().mockResolvedValue(undefined);
      await callbackPool.submit(createBatch("batch-1"), handler);
      await vi.runAllTimersAsync();

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          batchId: "batch-1",
        }),
      );
      callbackPool.forceShutdown();
    });

    it("should invoke callback on failure", async () => {
      const callback = vi.fn();
      const callbackPool = new WorkerPool(config, callback);

      const handler = vi.fn().mockRejectedValue(new Error("Test error"));

      const resultPromise = callbackPool.submit(
        createBatch("batch-1"),
        handler,
      );

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      await resultPromise;

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: "Test error",
        }),
      );
      callbackPool.forceShutdown();
    });
  });

  describe("Statistics", () => {
    it("should track processed count", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);

      await pool.submit(createBatch("batch-1"), handler);
      await pool.submit(createBatch("batch-2"), handler);
      await vi.runAllTimersAsync();

      const stats = pool.getStats();
      expect(stats.processed).toBe(2);
    });

    it("should track error count", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Fail"));

      const p1 = pool.submit(createBatch("batch-1"), handler);

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      await p1;

      const stats = pool.getStats();
      expect(stats.errors).toBe(1);
    });

    it("should calculate throughput", async () => {
      vi.useRealTimers();
      const realPool = new WorkerPool(config);

      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10)); // Ensure some time passes
      });

      await realPool.submit(createBatch("batch-1", 10), handler);
      await realPool.submit(createBatch("batch-2", 10), handler);

      const stats = realPool.getStats();
      expect(stats.processed).toBe(2);
      expect(stats.throughput).toBeGreaterThan(0);
      realPool.forceShutdown();
    });
  });

  describe("Shutdown", () => {
    it("should reject new batches after shutdown starts", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      pool.submit(createBatch("batch-1"), handler);

      const shutdownPromise = pool.shutdown();

      await expect(
        pool.submit(createBatch("batch-2"), handler),
      ).rejects.toThrow("WorkerPool is shutting down");

      await vi.runAllTimersAsync();
      await shutdownPromise;
    });

    it("should wait for in-progress work on graceful shutdown", async () => {
      vi.useRealTimers();
      const realPool = new WorkerPool(config);

      let completed = false;
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 100));
        completed = true;
      });

      realPool.submit(createBatch("batch-1"), handler);

      await realPool.shutdown();

      expect(completed).toBe(true);
    });

    it("should cancel pending work on force shutdown", async () => {
      const handler = vi.fn().mockImplementation(() => new Promise(() => {}));

      pool.submit(createBatch("batch-1"), handler);
      pool.submit(createBatch("batch-2"), handler);
      const p3 = pool.submit(createBatch("batch-3"), handler);
      const p4 = pool.submit(createBatch("batch-4"), handler);

      pool.forceShutdown();

      // Queued batches should be cancelled (resolved with error, not rejected)
      expect(pool.getQueueDepth()).toBe(0);

      // Verify cancelled batches resolve with failure status
      const [result3, result4] = await Promise.all([p3, p4]);
      expect(result3.success).toBe(false);
      expect(result3.error).toBe("WorkerPool force shutdown");
      expect(result4.success).toBe(false);
      expect(result4.error).toBe("WorkerPool force shutdown");
    });
  });

  describe("Drain", () => {
    it("should wait for all batches to complete", async () => {
      vi.useRealTimers();
      const realPool = new WorkerPool(config);

      let completedCount = 0;
      const handler = vi.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50));
        completedCount++;
      });

      realPool.submit(createBatch("batch-1"), handler);
      realPool.submit(createBatch("batch-2"), handler);
      realPool.submit(createBatch("batch-3"), handler);

      await realPool.drain();

      expect(completedCount).toBe(3);
      realPool.forceShutdown();
    });
  });
});
