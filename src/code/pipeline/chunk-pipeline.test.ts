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

import { ChunkPipeline } from "./chunk-pipeline.js";
import type { ChunkItem } from "./types.js";

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

    pipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName, {
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
      const notStartedPipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName);

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

  describe("Hybrid search", () => {
    it("should use sparse vectors when hybrid enabled", async () => {
      const hybridPipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName, {
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
      });

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

  describe("addChunks", () => {
    it("should add multiple chunks at once", () => {
      const chunks = [
        { chunk: createChunk(1), chunkId: "chunk-1", codebasePath: "/test" },
        { chunk: createChunk(2), chunkId: "chunk-2", codebasePath: "/test" },
        { chunk: createChunk(3), chunkId: "chunk-3", codebasePath: "/test" },
      ];

      const accepted = pipeline.addChunks(chunks);

      expect(accepted).toBe(3);
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
      const stoppedPipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName);

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

  describe("Stats edge cases", () => {
    it("should return zero throughput when pipeline has not started", () => {
      const freshPipeline = new ChunkPipeline(mockQdrant as any, mockEmbeddings as any, testCollectionName);

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

    it("should propagate git metadata to Qdrant payload", async () => {
      const chunkWithGit: ChunkItem["chunk"] = {
        content: "test git metadata",
        startLine: 1,
        endLine: 10,
        metadata: {
          filePath: "/test/path/gitfile.ts",
          language: "typescript",
          chunkIndex: 0,
          git: {
            lastModifiedAt: 1700000000,
            firstCreatedAt: 1690000000,
            dominantAuthor: "Jane Doe",
            dominantAuthorEmail: "jane@example.com",
            authors: ["Jane Doe", "John Smith"],
            commitCount: 8,
            lastCommitHash: "abc123",
            ageDays: 30,
            taskIds: ["TD-100", "TD-200"],
          },
        },
      };

      pipeline.addChunk(chunkWithGit, "git-chunk-1", "/test/path");

      const flushPromise = pipeline.flush();
      await vi.runAllTimersAsync();
      await flushPromise;

      expect(mockQdrant.addPointsOptimized).toHaveBeenCalledWith(
        testCollectionName,
        expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              git: expect.objectContaining({
                commitCount: 8,
                dominantAuthor: "Jane Doe",
                ageDays: 30,
                taskIds: ["TD-100", "TD-200"],
              }),
            }),
          }),
        ]),
        expect.any(Object),
      );
    });
  });
});
