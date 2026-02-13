/**
 * Tests for ChunkPipeline onBatchUpserted callback
 *
 * Verifies that the callback fires after successful batch upserts,
 * doesn't fire when not set, and doesn't fire on batch failure.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChunkPipeline } from "../../../src/code/pipeline/chunk-pipeline.js";
import type { ChunkItem } from "../../../src/code/pipeline/types.js";

// Minimal mock EmbeddingProvider
function createMockEmbeddings(dimensions = 384) {
  return {
    getDimensions: () => dimensions,
    getModel: () => "mock",
    embed: vi.fn().mockResolvedValue({ embedding: new Array(dimensions).fill(0.1), dimensions }),
    embedBatch: vi
      .fn()
      .mockImplementation(async (texts: string[]) =>
        Promise.resolve(texts.map(() => ({ embedding: new Array(dimensions).fill(0.1), dimensions }))),
      ),
  };
}

// Minimal mock QdrantManager
function createMockQdrant() {
  return {
    addPointsOptimized: vi.fn().mockResolvedValue(undefined),
    addPointsWithSparse: vi.fn().mockResolvedValue(undefined),
    addPoints: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChunkItem(
  id: string,
  filePath: string,
  content: string,
): {
  chunk: ChunkItem["chunk"];
  chunkId: string;
  codebasePath: string;
} {
  return {
    chunk: {
      content,
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath,
        language: "typescript",
        chunkIndex: 0,
      },
    } as ChunkItem["chunk"],
    chunkId: id,
    codebasePath: "/repo",
  };
}

describe("ChunkPipeline onBatchUpserted callback", () => {
  let qdrant: ReturnType<typeof createMockQdrant>;
  let embeddings: ReturnType<typeof createMockEmbeddings>;

  beforeEach(() => {
    qdrant = createMockQdrant();
    embeddings = createMockEmbeddings();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should fire callback after successful upsert with correct items", async () => {
    const callback = vi.fn();
    const pipeline = new ChunkPipeline(qdrant as any, embeddings as any, "test_collection", {
      workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      accumulator: { batchSize: 2, flushTimeoutMs: 100, maxQueueSize: 10 },
      enableHybrid: false,
    });

    pipeline.setOnBatchUpserted(callback);
    pipeline.start();

    // Add 2 chunks to trigger a batch (batchSize=2)
    const item1 = makeChunkItem("c1", "/repo/a.ts", "const a = 1;");
    const item2 = makeChunkItem("c2", "/repo/b.ts", "const b = 2;");
    pipeline.addChunk(item1.chunk, item1.chunkId, item1.codebasePath);
    pipeline.addChunk(item2.chunk, item2.chunkId, item2.codebasePath);

    await pipeline.flush();
    await pipeline.shutdown();

    expect(callback).toHaveBeenCalledTimes(1);
    const callArgs = callback.mock.calls[0][0] as ChunkItem[];
    expect(callArgs).toHaveLength(2);
    expect(callArgs[0].chunkId).toBe("c1");
    expect(callArgs[1].chunkId).toBe("c2");
  });

  it("should not call callback if no setter was called", async () => {
    const pipeline = new ChunkPipeline(qdrant as any, embeddings as any, "test_collection", {
      workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      accumulator: { batchSize: 1, flushTimeoutMs: 100, maxQueueSize: 10 },
      enableHybrid: false,
    });

    // No setOnBatchUpserted call
    pipeline.start();

    const item = makeChunkItem("c1", "/repo/a.ts", "const a = 1;");
    pipeline.addChunk(item.chunk, item.chunkId, item.codebasePath);

    await pipeline.flush();
    await pipeline.shutdown();

    // Should not throw — just silently does nothing
    expect(qdrant.addPointsOptimized).toHaveBeenCalled();
  });

  it("should not call callback on batch failure (error path)", async () => {
    const callback = vi.fn();

    // Make Qdrant upsert fail
    const failingQdrant = createMockQdrant();
    failingQdrant.addPointsOptimized.mockRejectedValue(new Error("Qdrant down"));

    const pipeline = new ChunkPipeline(failingQdrant as any, embeddings as any, "test_collection", {
      workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      accumulator: { batchSize: 1, flushTimeoutMs: 100, maxQueueSize: 10 },
      enableHybrid: false,
    });

    pipeline.setOnBatchUpserted(callback);
    pipeline.start();

    const item = makeChunkItem("c1", "/repo/a.ts", "const a = 1;");
    pipeline.addChunk(item.chunk, item.chunkId, item.codebasePath);

    await pipeline.flush();
    await pipeline.shutdown();

    expect(callback).not.toHaveBeenCalled();
  });

  it("should fire callback for each batch separately", async () => {
    const callback = vi.fn();
    const pipeline = new ChunkPipeline(qdrant as any, embeddings as any, "test_collection", {
      workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 100 },
      accumulator: { batchSize: 1, flushTimeoutMs: 100, maxQueueSize: 10 },
      enableHybrid: false,
    });

    pipeline.setOnBatchUpserted(callback);
    pipeline.start();

    // Add 3 chunks with batchSize=1, so 3 separate batches
    for (let i = 0; i < 3; i++) {
      const item = makeChunkItem(`c${i}`, `/repo/file${i}.ts`, `const x${i} = ${i};`);
      pipeline.addChunk(item.chunk, item.chunkId, item.codebasePath);
    }

    await pipeline.flush();
    await pipeline.shutdown();

    expect(callback).toHaveBeenCalledTimes(3);
    expect((callback.mock.calls[0][0] as ChunkItem[])[0].chunkId).toBe("c0");
    expect((callback.mock.calls[1][0] as ChunkItem[])[0].chunkId).toBe("c1");
    expect((callback.mock.calls[2][0] as ChunkItem[])[0].chunkId).toBe("c2");
  });
});
