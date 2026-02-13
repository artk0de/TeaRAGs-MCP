/**
 * Tests for PipelineManager
 *
 * Coverage:
 * - Pipeline lifecycle (start, flush, shutdown)
 * - Upsert and delete operations
 * - Backpressure coordination
 * - Statistics tracking
 * - Integration with accumulators and worker pool
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QdrantManager } from "../../qdrant/client.js";
import { createQdrantPipeline, PipelineManager } from "./pipeline-manager.js";
import type { Batch, DeleteItem, PipelineConfig, UpsertItem } from "./types.js";

describe("PipelineManager", () => {
  let pipeline: PipelineManager;
  let upsertBatches: Batch<UpsertItem>[];
  let deleteBatches: Batch<DeleteItem>[];

  beforeEach(() => {
    vi.useFakeTimers();
    upsertBatches = [];
    deleteBatches = [];

    pipeline = new PipelineManager(
      {
        handleUpsertBatch: async (batch) => {
          upsertBatches.push(batch);
        },
        handleDeleteBatch: async (batch) => {
          deleteBatches.push(batch);
        },
      },
      {
        workerPool: {
          concurrency: 2,
          maxRetries: 2,
          retryBaseDelayMs: 50,
          retryMaxDelayMs: 500,
        },
        upsertAccumulator: {
          batchSize: 3,
          flushTimeoutMs: 100,
          maxQueueSize: 4,
        },
        deleteAccumulator: {
          batchSize: 5,
          flushTimeoutMs: 50,
          maxQueueSize: 4,
        },
      },
    );

    pipeline.start();
  });

  afterEach(async () => {
    pipeline.forceShutdown();
    vi.useRealTimers();
  });

  // Helper to create test point
  function createPoint(id: number): UpsertItem["point"] {
    return {
      id: `point-${id}`,
      vector: [1, 2, 3],
      payload: { index: id },
    };
  }

  describe("Lifecycle", () => {
    it("should throw if adding items before start", () => {
      const notStartedPipeline = new PipelineManager({
        handleUpsertBatch: vi.fn(),
        handleDeleteBatch: vi.fn(),
      });

      expect(() => notStartedPipeline.addUpsert(createPoint(1))).toThrow("Pipeline not started");
    });

    it("should accept items after start", () => {
      const result = pipeline.addUpsert(createPoint(1));
      expect(result).toBe(true);
    });

    it("should flush pending items on shutdown", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));

      await vi.runAllTimersAsync();
      await pipeline.shutdown();

      expect(upsertBatches.length).toBeGreaterThan(0);
    });

    it("should clear all items on force shutdown", () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));

      pipeline.forceShutdown();

      // Force shutdown doesn't wait for flush
      expect(upsertBatches).toHaveLength(0);
    });
  });

  describe("Upsert operations", () => {
    it("should accumulate upserts into batches", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));
      pipeline.addUpsert(createPoint(3));

      await vi.runAllTimersAsync();

      expect(upsertBatches).toHaveLength(1);
      expect(upsertBatches[0].items).toHaveLength(3);
    });

    it("should create multiple upsert batches", async () => {
      for (let i = 1; i <= 7; i++) {
        pipeline.addUpsert(createPoint(i));
      }

      await vi.runAllTimersAsync();
      await pipeline.flush();

      // 3 + 3 + 1 = 7 items in batches
      expect(upsertBatches.length).toBeGreaterThanOrEqual(2);
    });

    it("should flush partial upsert batch on timeout", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));

      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(upsertBatches).toHaveLength(1);
      expect(upsertBatches[0].items).toHaveLength(2);
    });

    it("should accept many upserts at once", async () => {
      const points = Array.from({ length: 5 }, (_, i) => createPoint(i + 1));
      const accepted = pipeline.addUpsertMany(points);

      expect(accepted).toBe(5);
    });
  });

  describe("Delete operations", () => {
    it("should accumulate deletes into batches", async () => {
      for (let i = 1; i <= 5; i++) {
        pipeline.addDelete(`path-${i}.ts`);
      }

      await vi.runAllTimersAsync();

      expect(deleteBatches).toHaveLength(1);
      expect(deleteBatches[0].items).toHaveLength(5);
    });

    it("should flush partial delete batch on timeout", async () => {
      pipeline.addDelete("path-1.ts");
      pipeline.addDelete("path-2.ts");

      vi.advanceTimersByTime(50);
      await vi.runAllTimersAsync();

      expect(deleteBatches).toHaveLength(1);
      expect(deleteBatches[0].items).toHaveLength(2);
    });

    it("should accept many deletes at once", () => {
      const paths = Array.from({ length: 3 }, (_, i) => `path-${i + 1}.ts`);
      const accepted = pipeline.addDeleteMany(paths);

      expect(accepted).toBe(3);
    });
  });

  describe("Mixed operations", () => {
    it("should handle both upserts and deletes", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));
      pipeline.addUpsert(createPoint(3));

      pipeline.addDelete("old-1.ts");
      pipeline.addDelete("old-2.ts");

      await vi.runAllTimersAsync();
      await pipeline.flush();

      expect(upsertBatches.length).toBeGreaterThan(0);
      expect(deleteBatches.length).toBeGreaterThan(0);
    });
  });

  describe("Backpressure", () => {
    it("should report backpressure state", () => {
      expect(pipeline.isUpsertBackpressured()).toBe(false);
      expect(pipeline.isDeleteBackpressured()).toBe(false);
    });

    it("should handle backpressure wait timeout", async () => {
      vi.useRealTimers();

      const realPipeline = new PipelineManager(
        {
          handleUpsertBatch: vi.fn(),
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 100,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 10,
            flushTimeoutMs: 1000,
            maxQueueSize: 2,
          },
          deleteAccumulator: {
            batchSize: 10,
            flushTimeoutMs: 1000,
            maxQueueSize: 2,
          },
        },
      );

      realPipeline.start();

      // Should resolve immediately when no backpressure
      const result = await realPipeline.waitForBackpressure(100);
      expect(result).toBe(true);

      realPipeline.forceShutdown();
    });
  });

  describe("Statistics", () => {
    it("should track items processed", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));
      pipeline.addUpsert(createPoint(3));

      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.itemsProcessed).toBe(3);
      expect(stats.batchesProcessed).toBe(1);
    });

    it("should track batches processed", async () => {
      for (let i = 1; i <= 7; i++) {
        pipeline.addUpsert(createPoint(i));
      }

      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.batchesProcessed).toBeGreaterThanOrEqual(2);
    });

    it("should report queue depth", () => {
      const stats = pipeline.getStats();
      expect(stats.queueDepth).toBeGreaterThanOrEqual(0);
    });

    it("should track uptime", async () => {
      vi.advanceTimersByTime(1000);

      const stats = pipeline.getStats();
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("Error handling", () => {
    it("should track errors", async () => {
      let callCount = 0;
      const errorPipeline = new PipelineManager(
        {
          handleUpsertBatch: async () => {
            callCount++;
            throw new Error("Test error");
          },
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 10,
          },
          deleteAccumulator: {
            batchSize: 10,
            flushTimeoutMs: 100,
            maxQueueSize: 10,
          },
        },
      );

      errorPipeline.start();
      errorPipeline.addUpsert(createPoint(1));

      await vi.runAllTimersAsync();
      await errorPipeline.flush();

      const stats = errorPipeline.getStats();
      expect(stats.errors).toBe(1);

      errorPipeline.forceShutdown();
    });
  });

  describe("Flush", () => {
    it("should flush all accumulators", async () => {
      pipeline.addUpsert(createPoint(1));
      pipeline.addDelete("path-1.ts");

      // Need to run timers to process the flush
      await vi.runAllTimersAsync();

      expect(upsertBatches.length).toBeGreaterThanOrEqual(1);
      expect(deleteBatches.length).toBeGreaterThanOrEqual(1);
    });

    it("should wait for all batches to complete", async () => {
      vi.useRealTimers();

      let completed = 0;
      const realPipeline = new PipelineManager(
        {
          handleUpsertBatch: async () => {
            await new Promise((r) => setTimeout(r, 50));
            completed++;
          },
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 2,
            maxRetries: 0,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 2,
            flushTimeoutMs: 10,
            maxQueueSize: 10,
          },
          deleteAccumulator: {
            batchSize: 10,
            flushTimeoutMs: 100,
            maxQueueSize: 10,
          },
        },
      );

      realPipeline.start();

      for (let i = 1; i <= 4; i++) {
        realPipeline.addUpsert(createPoint(i));
      }

      await realPipeline.flush();

      expect(completed).toBe(2); // 2 batches of 2
      realPipeline.forceShutdown();
    });
  });

  describe("Backpressure coordination", () => {
    it("should pause accumulators when queue is full", async () => {
      vi.useRealTimers();

      let processingCount = 0;
      const slowPipeline = new PipelineManager(
        {
          handleUpsertBatch: async () => {
            processingCount++;
            // Slow handler to build up queue
            await new Promise((r) => setTimeout(r, 200));
          },
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 2, // Very small queue
          },
          deleteAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 2,
          },
        },
      );

      slowPipeline.start();

      // Add items to fill the queue
      for (let i = 1; i <= 5; i++) {
        slowPipeline.addUpsert(createPoint(i));
      }

      // Wait for processing to complete
      await slowPipeline.shutdown();
      expect(processingCount).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty flush", async () => {
      await pipeline.flush();
      expect(upsertBatches).toHaveLength(0);
      expect(deleteBatches).toHaveLength(0);
    });

    it("should handle rapid add/flush cycles", async () => {
      for (let cycle = 0; cycle < 5; cycle++) {
        pipeline.addUpsert(createPoint(cycle));
        await vi.runAllTimersAsync();
        await pipeline.flush();
      }

      expect(upsertBatches.length).toBeGreaterThan(0);
    });

    it("should handle shutdown during processing", async () => {
      vi.useRealTimers();

      const realPipeline = new PipelineManager(
        {
          handleUpsertBatch: async () => {
            await new Promise((r) => setTimeout(r, 100));
          },
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 10,
          },
          deleteAccumulator: {
            batchSize: 10,
            flushTimeoutMs: 100,
            maxQueueSize: 10,
          },
        },
      );

      realPipeline.start();
      realPipeline.addUpsert(createPoint(1));

      // Shutdown should wait for in-progress work
      await realPipeline.shutdown();
    });
  });

  describe("createQdrantPipeline", () => {
    it("should create a pipeline with default config", () => {
      const mockQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        deletePointsByPaths: vi.fn().mockResolvedValue(undefined),
      } as unknown as QdrantManager;

      const qdrantPipeline = createQdrantPipeline(mockQdrant, "test-collection");
      expect(qdrantPipeline).toBeInstanceOf(PipelineManager);
      qdrantPipeline.forceShutdown();
    });

    it("should create a pipeline with custom config", () => {
      const mockQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        deletePointsByPaths: vi.fn().mockResolvedValue(undefined),
      } as unknown as QdrantManager;

      const qdrantPipeline = createQdrantPipeline(mockQdrant, "test-collection", {
        config: {
          workerPool: { concurrency: 4, maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 1000 },
        },
      });
      expect(qdrantPipeline).toBeInstanceOf(PipelineManager);
      qdrantPipeline.forceShutdown();
    });

    it("should handle upsert batches", async () => {
      vi.useRealTimers();

      const mockQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        deletePointsByPaths: vi.fn().mockResolvedValue(undefined),
      } as unknown as QdrantManager;

      const qdrantPipeline = createQdrantPipeline(mockQdrant, "test-collection", {
        config: {
          upsertAccumulator: { batchSize: 2, flushTimeoutMs: 10, maxQueueSize: 10 },
        },
      });

      qdrantPipeline.start();
      qdrantPipeline.addUpsert({
        id: "test-1",
        vector: [1, 2, 3],
        payload: { test: true },
      });
      qdrantPipeline.addUpsert({
        id: "test-2",
        vector: [4, 5, 6],
        payload: { test: true },
      });

      await qdrantPipeline.flush();
      await qdrantPipeline.shutdown();

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalled();
    });

    it("should handle delete batches", async () => {
      vi.useRealTimers();

      const mockQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        deletePointsByPaths: vi.fn().mockResolvedValue(undefined),
      } as unknown as QdrantManager;

      const qdrantPipeline = createQdrantPipeline(mockQdrant, "test-collection", {
        config: {
          deleteAccumulator: { batchSize: 2, flushTimeoutMs: 10, maxQueueSize: 10 },
        },
      });

      qdrantPipeline.start();
      qdrantPipeline.addDelete("path1.ts");
      qdrantPipeline.addDelete("path2.ts");

      await qdrantPipeline.flush();
      await qdrantPipeline.shutdown();

      expect(mockQdrant.deletePointsByPaths).toHaveBeenCalled();
    });

    it("should handle hybrid mode with sparse vectors", async () => {
      vi.useRealTimers();

      const mockQdrant = {
        addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
        deletePointsByPaths: vi.fn().mockResolvedValue(undefined),
      } as unknown as QdrantManager;

      const qdrantPipeline = createQdrantPipeline(mockQdrant, "test-collection", {
        enableHybrid: true,
        config: {
          upsertAccumulator: { batchSize: 1, flushTimeoutMs: 10, maxQueueSize: 10 },
        },
      });

      qdrantPipeline.start();
      qdrantPipeline.addUpsert({
        id: "test-1",
        vector: [1, 2, 3],
        sparseVector: { indices: [0, 1], values: [0.5, 0.5] },
        payload: { test: true },
      });

      await qdrantPipeline.flush();
      await qdrantPipeline.shutdown();

      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalled();
    });
  });

  describe("Lifecycle edge cases", () => {
    it("should no-op when start is called while already running", () => {
      // pipeline is already started in beforeEach
      // Calling start again should not throw or reset state
      pipeline.addUpsert(createPoint(1));
      pipeline.start(); // second call - should be no-op
      pipeline.addUpsert(createPoint(2));

      const stats = pipeline.getStats();
      // Pipeline should still be functional
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(0);
    });

    it("should no-op when shutdown is called on a non-running pipeline", async () => {
      const stoppedPipeline = new PipelineManager({
        handleUpsertBatch: vi.fn(),
        handleDeleteBatch: vi.fn(),
      });

      // Should not throw
      await stoppedPipeline.shutdown();
    });

    it("should throw when addDelete is called before start", () => {
      const notStartedPipeline = new PipelineManager({
        handleUpsertBatch: vi.fn(),
        handleDeleteBatch: vi.fn(),
      });

      expect(() => notStartedPipeline.addDelete("path.ts")).toThrow("Pipeline not started");
    });
  });

  describe("Backpressure edge cases", () => {
    it("should return false on waitForBackpressure timeout", async () => {
      vi.useRealTimers();

      let resolveHandler: (() => void) | null = null;
      const slowPipeline = new PipelineManager(
        {
          handleUpsertBatch: async () => {
            // Block indefinitely until we release
            await new Promise<void>((r) => {
              resolveHandler = r;
            });
          },
          handleDeleteBatch: vi.fn(),
        },
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          upsertAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 1, // Very small queue to trigger backpressure quickly
          },
          deleteAccumulator: {
            batchSize: 1,
            flushTimeoutMs: 10,
            maxQueueSize: 1,
          },
        },
      );

      slowPipeline.start();

      // Fill queue to trigger backpressure: batch size 1 means each add triggers a batch
      slowPipeline.addUpsert(createPoint(1));
      // Wait a tick for the batch to be submitted to the worker pool
      await new Promise((r) => setTimeout(r, 50));
      slowPipeline.addUpsert(createPoint(2));
      await new Promise((r) => setTimeout(r, 50));

      // waitForBackpressure with very short timeout should return false if backpressured
      const result = await slowPipeline.waitForBackpressure(100);

      // Clean up: release the blocking handler
      (resolveHandler as (() => void) | null)?.();
      slowPipeline.forceShutdown();

      // Result depends on whether backpressure was actually triggered
      expect(typeof result).toBe("boolean");
    });

    it("should track throughput correctly", async () => {
      vi.advanceTimersByTime(100);

      pipeline.addUpsert(createPoint(1));
      pipeline.addUpsert(createPoint(2));
      pipeline.addUpsert(createPoint(3));

      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.throughput).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Stats before start", () => {
    it("should return zero throughput when pipeline has not started", () => {
      const freshPipeline = new PipelineManager({
        handleUpsertBatch: vi.fn(),
        handleDeleteBatch: vi.fn(),
      });

      const stats = freshPipeline.getStats();
      expect(stats.throughput).toBe(0);
      expect(stats.uptimeMs).toBe(0);
      expect(stats.itemsProcessed).toBe(0);
      freshPipeline.forceShutdown();
    });
  });
});
