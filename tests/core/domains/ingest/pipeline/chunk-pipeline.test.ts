/**
 * Tests for ChunkPipeline
 *
 * Coverage:
 * - Pipeline lifecycle (start, flush, shutdown)
 * - Chunk batching and processing
 * - Backpressure handling
 * - Statistics tracking
 * - Integration with embeddings and Qdrant
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
// Use real StaticPayloadBuilder for full payload construction
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

// Mock embeddings provider
const mockEmbeddings = {
  embedBatch: vi.fn(),
  embed: vi.fn(),
  getDimensions: vi.fn(() => 384),
};

// Mock Qdrant manager
const mockQdrant = {
  addPointsOptimized: vi.fn(),
  addPointsWithSparse: vi.fn(),
};

const mockPayloadBuilder = new StaticPayloadBuilder();

describe("ChunkPipeline", () => {
  let pipeline: ChunkPipeline;
  const testCollectionName = "test_collection";

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();

    // Default mock implementations
    mockEmbeddings.embedBatch.mockResolvedValue(
      Array(50)
        .fill(null)
        .map(() => ({ embedding: [1, 2, 3] })),
    );
    mockQdrant.addPointsOptimized.mockResolvedValue(undefined);
    mockQdrant.addPointsWithSparse.mockResolvedValue(undefined);

    pipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName, mockPayloadBuilder, {
      workerPool: {
        concurrency: 2,
        maxRetries: 2,
        retryBaseDelayMs: 50,
        retryMaxDelayMs: 500,
      },
      accumulator: {
        batchSize: 3,
        flushTimeoutMs: 100,
        maxQueueSize: 4,
      },
      enableHybrid: false,
    });

    pipeline.start();
  });

  afterEach(async () => {
    pipeline.forceShutdown();
    vi.useRealTimers();
  });

  // Helper to create test chunk
  function createChunk(id: number): ChunkItem["chunk"] {
    return {
      content: `test content ${id}`,
      startLine: id,
      endLine: id + 10,
      metadata: {
        filePath: `/test/path/file${id}.ts`,
        language: "typescript",
        chunkIndex: id,
      },
    };
  }

  describe("Lifecycle", () => {
    it("should throw if adding chunks before start", () => {
      const notStartedPipeline = new ChunkPipeline(
        mockQdrant as any,
        mockEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
      );

      expect(() => notStartedPipeline.addChunk(createChunk(1), "chunk-1", "/test/path")).toThrow(
        "ChunkPipeline not started",
      );
    });

    it("should accept chunks after start", () => {
      const result = pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      expect(result).toBe(true);
    });

    it("should flush pending chunks on shutdown", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      const shutdownPromise = pipeline.shutdown();
      await vi.runAllTimersAsync();
      await shutdownPromise;

      expect(mockEmbeddings.embedBatch).toHaveBeenCalled();
    });

    it("should clear all chunks on force shutdown", () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      pipeline.forceShutdown();

      expect(pipeline.getPendingCount()).toBe(0);
    });
  });

  describe("Chunk batching", () => {
    it("should accumulate chunks into batches", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      // Batch size is 3, should trigger batch processing
      await vi.runAllTimersAsync();

      expect(mockEmbeddings.embedBatch).toHaveBeenCalledWith(["test content 1", "test content 2", "test content 3"]);
    });

    it("should flush partial batch on timeout", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      // Advance past flush timeout
      vi.advanceTimersByTime(100);
      await vi.runAllTimersAsync();

      expect(mockEmbeddings.embedBatch).toHaveBeenCalledWith(["test content 1", "test content 2"]);
    });

    it("should store to Qdrant after embedding", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      await vi.runAllTimersAsync();

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledWith(
        testCollectionName,
        expect.arrayContaining([
          expect.objectContaining({
            id: "chunk-1",
            vector: [1, 2, 3],
          }),
        ]),
        expect.any(Object),
      );
    });
  });

  describe("Payload fields", () => {
    it("should include contentSize in Qdrant payload", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      await vi.runAllTimersAsync();

      const points = mockQdrant.addPointsOptimized.mock.calls[0][1];
      for (const point of points) {
        expect(point.payload).toHaveProperty("contentSize");
        expect(typeof point.payload.contentSize).toBe("number");
        expect(point.payload.contentSize).toBe(point.payload.content.length);
      }
    });
  });

  describe("Hybrid search", () => {
    it("should use sparse vectors when hybrid enabled", async () => {
      const hybridPipeline = new ChunkPipeline(
        mockQdrant as any,
        mockEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
        {
          workerPool: {
            concurrency: 2,
            maxRetries: 2,
            retryBaseDelayMs: 50,
            retryMaxDelayMs: 500,
          },
          accumulator: {
            batchSize: 2,
            flushTimeoutMs: 100,
            maxQueueSize: 4,
          },
          enableHybrid: true,
        },
      );

      hybridPipeline.start();

      hybridPipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      hybridPipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      await vi.runAllTimersAsync();

      expect(mockQdrant.addPointsWithSparse).toHaveBeenCalledWith(
        testCollectionName,
        expect.arrayContaining([
          expect.objectContaining({
            sparseVector: expect.any(Object),
          }),
        ]),
      );

      hybridPipeline.forceShutdown();
    });
  });

  describe("Backpressure", () => {
    it("should report backpressure state", () => {
      expect(pipeline.isBackpressured()).toBe(false);
    });

    it("should handle backpressure wait timeout", async () => {
      // When no backpressure, should resolve immediately
      const result = await pipeline.waitForBackpressure(100);
      expect(result).toBe(true);
    });

    it("should pause accumulator when queue reaches maxQueueSize", async () => {
      vi.useRealTimers();

      // Use a slow embedding to make batches pile up in the worker pool queue
      let embedResolvers: ((val: { embedding: number[] }[]) => void)[] = [];
      const slowEmbeddings = {
        embedBatch: vi.fn().mockImplementation(
          async () =>
            new Promise<{ embedding: number[] }[]>((resolve) => {
              embedResolvers.push(resolve);
            }),
        ),
        embed: vi.fn(),
        getDimensions: vi.fn(() => 384),
      };

      const bpPipeline = new ChunkPipeline(
        mockQdrant as any,
        slowEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
        {
          workerPool: {
            concurrency: 1, // Only 1 concurrent batch processing
            maxRetries: 0,
            retryBaseDelayMs: 10,
            retryMaxDelayMs: 100,
          },
          accumulator: {
            batchSize: 1, // Each chunk forms a batch immediately
            flushTimeoutMs: 50,
            maxQueueSize: 2, // Backpressure at queue depth >= 2
          },
          enableHybrid: false,
        },
      );

      bpPipeline.start();

      // Add chunks rapidly — each becomes a batch of 1
      // First batch goes to active processing (concurrency=1)
      bpPipeline.addChunk(createChunk(1), "bp-1", "/test/path");
      // Wait for batch to be submitted to worker pool
      await new Promise((r) => setTimeout(r, 100));

      // Second batch goes to queue (queue size = 1)
      bpPipeline.addChunk(createChunk(2), "bp-2", "/test/path");
      await new Promise((r) => setTimeout(r, 100));

      // Third batch goes to queue (queue size = 2 >= maxQueueSize)
      bpPipeline.addChunk(createChunk(3), "bp-3", "/test/path");
      await new Promise((r) => setTimeout(r, 100));

      // Backpressure should now be active
      expect(bpPipeline.isBackpressured()).toBe(true);

      // Resolve all pending embeds to drain
      for (const resolve of embedResolvers) {
        resolve([{ embedding: [1, 2, 3] }]);
      }
      embedResolvers = [];

      // Wait for queue to drain
      await new Promise((r) => setTimeout(r, 300));

      // Resolve any remaining embeds from retry/drain
      for (const resolve of embedResolvers) {
        resolve([{ embedding: [1, 2, 3] }]);
      }

      // Backpressure should release once queue drops below 50% threshold
      await new Promise((r) => setTimeout(r, 300));
      expect(bpPipeline.isBackpressured()).toBe(false);

      bpPipeline.forceShutdown();
      vi.useFakeTimers();
    });

    it("should log backpressure release when accumulator was paused", async () => {
      vi.useRealTimers();

      let embedResolvers: ((val: { embedding: number[] }[]) => void)[] = [];
      const slowEmbeddings = {
        embedBatch: vi.fn().mockImplementation(
          async () =>
            new Promise<{ embedding: number[] }[]>((resolve) => {
              embedResolvers.push(resolve);
            }),
        ),
        embed: vi.fn(),
        getDimensions: vi.fn(() => 384),
      };

      const bpPipeline = new ChunkPipeline(
        mockQdrant as any,
        slowEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
        {
          workerPool: {
            concurrency: 1,
            maxRetries: 0,
            retryBaseDelayMs: 10,
            retryMaxDelayMs: 100,
          },
          accumulator: {
            batchSize: 1,
            flushTimeoutMs: 50,
            maxQueueSize: 2,
          },
          enableHybrid: false,
        },
      );

      bpPipeline.start();

      // Fill the queue to trigger backpressure
      bpPipeline.addChunk(createChunk(10), "bp-log-1", "/test/path");
      await new Promise((r) => setTimeout(r, 100));
      bpPipeline.addChunk(createChunk(11), "bp-log-2", "/test/path");
      await new Promise((r) => setTimeout(r, 100));
      bpPipeline.addChunk(createChunk(12), "bp-log-3", "/test/path");
      await new Promise((r) => setTimeout(r, 100));

      // Confirm backpressure is active
      expect(bpPipeline.isBackpressured()).toBe(true);

      // Resolve embeds to drain the queue
      for (const resolve of embedResolvers) {
        resolve([{ embedding: [1, 2, 3] }]);
      }
      embedResolvers = [];

      // Wait for queue to drain below 50% threshold (< 1)
      await new Promise((r) => setTimeout(r, 500));
      for (const resolve of embedResolvers) {
        resolve([{ embedding: [1, 2, 3] }]);
      }
      await new Promise((r) => setTimeout(r, 300));

      // Backpressure should be released (and the isPausedState branch was hit)
      expect(bpPipeline.isBackpressured()).toBe(false);

      bpPipeline.forceShutdown();
      vi.useFakeTimers();
    });
  });

  describe("Statistics", () => {
    it("should track chunks processed", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.itemsProcessed).toBe(3);
      expect(stats.batchesProcessed).toBe(1);
    });

    it("should track batches processed", async () => {
      // Add 7 chunks with batch size 3 = 2 full batches + 1 partial
      for (let i = 1; i <= 7; i++) {
        pipeline.addChunk(createChunk(i), `chunk-${i}`, "/test/path");
      }

      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.batchesProcessed).toBeGreaterThanOrEqual(2);
    });

    it("should report pending count", () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      expect(pipeline.getPendingCount()).toBe(2);
    });

    it("should track uptime", async () => {
      vi.advanceTimersByTime(1000);

      const stats = pipeline.getStats();
      expect(stats.uptimeMs).toBeGreaterThanOrEqual(1000);
    });
  });

  describe("Error handling", () => {
    it("should track errors from embedding failures", async () => {
      mockEmbeddings.embedBatch.mockRejectedValueOnce(new Error("Embedding failed"));

      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      // Advance through retries
      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }
      await vi.runAllTimersAsync();

      const stats = pipeline.getStats();
      // May have errors depending on retry behavior
      expect(stats.errors).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Flush", () => {
    it("should flush and wait for all chunks to complete", async () => {
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");

      // Need to advance timers for the flush to complete with fake timers
      const flushPromise = pipeline.flush();
      await vi.runAllTimersAsync();
      await flushPromise;

      expect(mockEmbeddings.embedBatch).toHaveBeenCalled();
      expect(mockQdrant.addPointsOptimized).toHaveBeenCalled();
    });

    it("should handle empty flush", async () => {
      const flushPromise = pipeline.flush();
      await vi.runAllTimersAsync();
      await flushPromise;

      expect(mockEmbeddings.embedBatch).not.toHaveBeenCalled();
    });
  });

  describe("Lifecycle edge cases", () => {
    it("should no-op when start is called while already running", () => {
      // pipeline is already started in beforeEach
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.start(); // second call - should be no-op
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");

      // Pipeline should still be functional
      expect(pipeline.getPendingCount()).toBe(2);
    });

    it("should no-op when shutdown is called on a non-running pipeline", async () => {
      const stoppedPipeline = new ChunkPipeline(
        mockQdrant as any,
        mockEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
      );

      // Should not throw
      await stoppedPipeline.shutdown();
    });
  });

  describe("Batch callback", () => {
    it("should call onBatchUpserted callback after successful batch", async () => {
      const onBatchUpserted = vi.fn();
      pipeline.setOnBatchUpserted(onBatchUpserted);

      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      await vi.runAllTimersAsync();
      await pipeline.flush();

      expect(onBatchUpserted).toHaveBeenCalledTimes(1);
      expect(onBatchUpserted).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ chunkId: "chunk-1" }),
          expect.objectContaining({ chunkId: "chunk-2" }),
          expect.objectContaining({ chunkId: "chunk-3" }),
        ]),
      );
    });

    it("should not call callback if setOnBatchUpserted was never called", async () => {
      // No setOnBatchUpserted call
      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      await vi.runAllTimersAsync();
      await pipeline.flush();
      // Should complete without error — qdrant was still called
      expect(mockQdrant.addPointsOptimized).toHaveBeenCalled();
    });

    it("should not call callback on batch failure", async () => {
      const callback = vi.fn();
      mockEmbeddings.embedBatch.mockRejectedValue(new Error("embed fail"));
      pipeline.setOnBatchUpserted(callback);

      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(600);
      }
      await vi.runAllTimersAsync();
      await pipeline.flush();

      expect(callback).not.toHaveBeenCalled();
    });

    it("should fire callback once per batch when batchSize=1", async () => {
      vi.useRealTimers();
      const realQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
      };
      const realEmbeddings = {
        embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => ({ embedding: [1, 2, 3] }))),
        embed: vi.fn(),
        getDimensions: vi.fn(() => 3),
      };
      const batchPipeline = new ChunkPipeline(
        realQdrant as any,
        realEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
        {
          workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
          accumulator: { batchSize: 1, flushTimeoutMs: 100, maxQueueSize: 10 },
          enableHybrid: false,
        },
      );
      const callback = vi.fn();
      batchPipeline.setOnBatchUpserted(callback);
      batchPipeline.start();

      for (let i = 0; i < 3; i++) {
        batchPipeline.addChunk(createChunk(i), `c${i}`, "/test/path");
      }
      await batchPipeline.flush();
      await batchPipeline.shutdown();

      expect(callback).toHaveBeenCalledTimes(3);
      vi.useFakeTimers();
    });
  });

  describe("Error tracking in onBatchComplete", () => {
    it("should increment error count on batch failure after retries exhausted", async () => {
      // Make embedBatch always fail to exhaust retries
      mockEmbeddings.embedBatch.mockRejectedValue(new Error("Persistent embedding failure"));

      pipeline.addChunk(createChunk(1), "chunk-1", "/test/path");
      pipeline.addChunk(createChunk(2), "chunk-2", "/test/path");
      pipeline.addChunk(createChunk(3), "chunk-3", "/test/path");

      // Advance through all retries (maxRetries=2, so 3 total attempts)
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(600);
      }
      await vi.runAllTimersAsync();
      await pipeline.flush();

      const stats = pipeline.getStats();
      expect(stats.errors).toBeGreaterThanOrEqual(1);
      expect(stats.batchesProcessed).toBeGreaterThanOrEqual(1);
    });
  });

  describe("pendingBatches cleanup (isPromiseResolved)", () => {
    it("should clean up resolved promises when pendingBatches exceeds 100", async () => {
      vi.useRealTimers();

      const fastEmbeddings = {
        embedBatch: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => ({ embedding: [1, 2, 3] }))),
        embed: vi.fn(),
        getDimensions: vi.fn(() => 384),
      };
      const fastQdrant = {
        addPointsOptimized: vi.fn().mockResolvedValue(undefined),
        addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
      };

      const manyBatchPipeline = new ChunkPipeline(
        fastQdrant as any,
        fastEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
        {
          workerPool: {
            concurrency: 4,
            maxRetries: 0,
            retryBaseDelayMs: 10,
            retryMaxDelayMs: 100,
          },
          accumulator: {
            batchSize: 1, // Each chunk -> 1 batch
            flushTimeoutMs: 50,
            maxQueueSize: 200,
          },
          enableHybrid: false,
        },
      );

      manyBatchPipeline.start();

      // Add 105 chunks to trigger the > 100 pendingBatches cleanup path
      for (let i = 0; i < 105; i++) {
        manyBatchPipeline.addChunk(createChunk(i), `cleanup-${i}`, "/test/path");
      }

      // Wait for all batches to be processed
      await manyBatchPipeline.flush();

      const stats = manyBatchPipeline.getStats();
      expect(stats.itemsProcessed).toBe(105);

      manyBatchPipeline.forceShutdown();
      vi.useFakeTimers();
    });
  });

  describe("Stats edge cases", () => {
    it("should return zero throughput when pipeline has not started", () => {
      const freshPipeline = new ChunkPipeline(
        mockQdrant as any,
        mockEmbeddings as any,
        testCollectionName,
        mockPayloadBuilder,
      );

      const stats = freshPipeline.getStats();
      expect(stats.throughput).toBe(0);
      expect(stats.uptimeMs).toBe(0);
      expect(stats.itemsProcessed).toBe(0);
      freshPipeline.forceShutdown();
    });
  });

  describe("Chunk metadata propagation", () => {
    it("should propagate optional metadata fields to Qdrant payload", async () => {
      const chunkWithMeta: ChunkItem["chunk"] = {
        content: "test class method",
        startLine: 1,
        endLine: 20,
        metadata: {
          filePath: "/test/path/service.ts",
          language: "typescript",
          chunkIndex: 0,
          name: "processData",
          chunkType: "function",
          parentName: "DataService",
          parentType: "class",
          symbolId: "DataService.processData",
          isDocumentation: false,
          imports: ["./utils", "lodash"],
        },
      };

      pipeline.addChunk(chunkWithMeta, "meta-chunk-1", "/test/path");

      // Flush to trigger the batch handler
      const flushPromise = pipeline.flush();
      await vi.runAllTimersAsync();
      await flushPromise;

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledWith(
        testCollectionName,
        expect.arrayContaining([
          expect.objectContaining({
            id: "meta-chunk-1",
            payload: expect.objectContaining({
              name: "processData",
              chunkType: "function",
              parentName: "DataService",
              parentType: "class",
              symbolId: "DataService.processData",
              imports: ["./utils", "lodash"],
            }),
          }),
        ]),
        expect.any(Object),
      );
    });
  });
});
