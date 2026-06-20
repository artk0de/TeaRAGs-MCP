import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OllamaContextOverflowError } from "../../../../../src/core/adapters/embeddings/ollama/errors.js";
import { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
import type { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/quarantine-store.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

const POISON = "x".repeat(5000);

const mockEmbeddings = {
  embedBatch: vi.fn(),
  embed: vi.fn(),
  getDimensions: vi.fn(() => 384),
};
const mockQdrant = {
  addPointsOptimized: vi.fn(),
  addPointsWithSparse: vi.fn(),
};

describe("ChunkPipeline — embed-phase quarantine isolation", () => {
  let pipeline: ChunkPipeline;
  // Mocked store (real fs I/O would not settle under vitest fake timers).
  const markFailed = vi.fn().mockResolvedValue(undefined);
  const store = { markFailed } as unknown as QuarantineStore;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockQdrant.addPointsOptimized.mockResolvedValue(undefined);

    // Full batch (or any solo chunk containing the poison) overflows; every
    // other solo re-embed succeeds. This drives the isolation path.
    mockEmbeddings.embedBatch.mockImplementation(async (texts: string[]) => {
      if (texts.some((t) => t.includes(POISON))) {
        throw new OllamaContextOverflowError("http://localhost:11434", 400, "context length exceeded");
      }
      return texts.map(() => ({ embedding: [1, 2, 3] }));
    });

    pipeline = new ChunkPipeline(
      mockQdrant as never,
      mockEmbeddings as never,
      "test_collection",
      new StaticPayloadBuilder(),
      {
        workerPool: { concurrency: 1, maxRetries: 2, retryBaseDelayMs: 50, retryMaxDelayMs: 500 },
        accumulator: { batchSize: 3, flushTimeoutMs: 100, maxQueueSize: 4 },
        enableHybrid: false,
      },
    );
    pipeline.setQuarantineStore(store);
    pipeline.start();
  });

  afterEach(() => {
    pipeline.forceShutdown();
    vi.useRealTimers();
  });

  function chunk(id: number, content: string): ChunkItem["chunk"] {
    return {
      content,
      startLine: id,
      endLine: id + 1,
      metadata: { filePath: `/base/file${id}.ts`, language: "typescript", chunkIndex: id },
    };
  }

  it("quarantines the culprit chunk's file and upserts the survivors without aborting", async () => {
    pipeline.addChunk(chunk(1, "healthy one"), "c1", "/base");
    pipeline.addChunk(chunk(2, POISON), "c2", "/base");
    pipeline.addChunk(chunk(3, "healthy three"), "c3", "/base");

    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(500);
    }
    await vi.runAllTimersAsync();

    // The pass must NOT abort — flush resolves.
    await expect(pipeline.flush()).resolves.toBeUndefined();

    // Only the culprit file is quarantined, with the embed-phase oversized error.
    expect(markFailed).toHaveBeenCalledTimes(1);
    const [path, err] = markFailed.mock.calls[0];
    expect(path).toBe("file2.ts");
    expect(err.code).toBe("INGEST_CHUNK_OVERSIZED");
    expect(err.phase).toBe("embed");

    // Survivors (file1, file3) were upserted — 2 points, not 3.
    expect(mockQdrant.addPointsOptimized).toHaveBeenCalled();
    const lastCall = mockQdrant.addPointsOptimized.mock.calls.at(-1);
    expect(lastCall?.[1]).toHaveLength(2);
  });
});
