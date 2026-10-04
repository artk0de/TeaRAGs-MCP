/**
 * ChunkPipeline × EmbeddingThroughputTuner (bd tea-rags-mcp-7ju66): the
 * accumulator forms batches at the tuner's size, the worker pool runs at the
 * tuner's concurrency, and both failure paths the pipeline cannot see from a
 * successful call — the provider's internal halving and a batch-level
 * rejection no single chunk reproduces — reach the tuner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmbeddingServerBatchFailure } from "../../../../../src/core/adapters/embeddings/base.js";
import { OllamaContextOverflowError } from "../../../../../src/core/adapters/embeddings/ollama/errors.js";
import { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import { EmbeddingThroughputTuner } from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
import { pipelineLog } from "../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import type { ChunkItem } from "../../../../../src/core/domains/ingest/pipeline/types.js";
import type { QuarantineStore } from "../../../../../src/core/domains/ingest/sync/quarantine-store.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

const REMOTE = "http://192.168.1.71:11434";
const LOCAL = "http://localhost:11434";

function makeEmbeddings(baseUrl: string) {
  let observer: ((event: EmbeddingServerBatchFailure) => void) | undefined;
  const embeddings = {
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 2, 3], dimensions: 3 }))),
    embed: vi.fn(),
    getDimensions: vi.fn(() => 3),
    getModel: vi.fn(() => "jina"),
    getBaseUrl: vi.fn(() => baseUrl),
    observeServerBatchFailures: vi.fn((o: (event: EmbeddingServerBatchFailure) => void) => {
      observer = o;
      return () => {
        observer = undefined;
      };
    }),
  };
  return {
    embeddings,
    reportFailure: (event: EmbeddingServerBatchFailure) => observer?.(event),
    isObserved: () => observer !== undefined,
  };
}

const mockQdrant = {
  addPointsOptimized: vi.fn(async () => undefined),
  addPointsWithSparse: vi.fn(async () => undefined),
};

function chunk(id: number, content = `content ${id}`): ChunkItem["chunk"] {
  return {
    content,
    startLine: id,
    endLine: id + 1,
    metadata: { filePath: `/base/file${id}.ts`, language: "typescript", chunkIndex: id },
  };
}

function makePipeline(
  embeddings: ReturnType<typeof makeEmbeddings>["embeddings"],
  tuner: EmbeddingThroughputTuner | undefined,
  concurrency = 2,
) {
  return new ChunkPipeline(mockQdrant as never, embeddings as never, "test_collection", new StaticPayloadBuilder(), {
    workerPool: { concurrency, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 10 },
    accumulator: { batchSize: 8, flushTimeoutMs: 100, maxQueueSize: 16 },
    enableHybrid: false,
    ...(tuner ? { throughputTuner: tuner } : {}),
  });
}

function tunerFor(seed?: number, seedConcurrency?: number) {
  return new EmbeddingThroughputTuner({
    ceiling: 8,
    floor: 1,
    configuredConcurrency: 2,
    recoveryStreak: 1000,
    // Never finish measuring a size: these tests pin batch FORMATION, not the climb.
    samplesPerSize: 1000,
    ...(seed !== undefined ? { seed: () => seed } : {}),
    ...(seedConcurrency !== undefined ? { seedConcurrency: () => seedConcurrency } : {}),
  });
}

const sentSizes = (embeddings: ReturnType<typeof makeEmbeddings>["embeddings"]) =>
  embeddings.embedBatch.mock.calls.map(([texts]) => texts.length);

async function settle(pipeline: ChunkPipeline): Promise<void> {
  for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(200);
  await pipeline.flush();
}

describe("ChunkPipeline — embedding throughput tuner", () => {
  let pipeline: ChunkPipeline | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    pipeline?.forceShutdown();
    pipeline = undefined;
    vi.useRealTimers();
  });

  it("forms batches at the tuner's size, not the configured one", async () => {
    const { embeddings } = makeEmbeddings(REMOTE);
    pipeline = makePipeline(embeddings, tunerFor(4));
    pipeline.start();

    for (let i = 0; i < 8; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);

    expect(sentSizes(embeddings)).toEqual([4, 4]);
  });

  it("keeps the configured batch size without a tuner (EMBEDDING_TUNE_STATIC)", async () => {
    const { embeddings } = makeEmbeddings(REMOTE);
    pipeline = makePipeline(embeddings, undefined);
    pipeline.start();

    for (let i = 0; i < 8; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);

    expect(sentSizes(embeddings)).toEqual([8]);
    expect(embeddings.observeServerBatchFailures).not.toHaveBeenCalled();
  });

  it("downshifts every later batch when the provider reports a server batch failure", async () => {
    const { embeddings, reportFailure } = makeEmbeddings(REMOTE);
    embeddings.embedBatch.mockImplementationOnce(async (texts: string[]) => {
      // The provider halved internally and succeeded — the call itself is green.
      reportFailure({ failedSize: texts.length, retrySize: texts.length / 2, endpointUrl: REMOTE });
      return texts.map(() => ({ embedding: [1, 2, 3], dimensions: 3 }));
    });
    pipeline = makePipeline(embeddings, tunerFor());
    pipeline.start();

    for (let i = 0; i < 8; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);
    for (let i = 8; i < 24; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);

    expect(sentSizes(embeddings)).toEqual([8, 4, 4, 4, 4]);
  });

  it("attaches to the provider while running and detaches on shutdown", async () => {
    const { embeddings, isObserved } = makeEmbeddings(REMOTE);
    pipeline = makePipeline(embeddings, tunerFor());
    pipeline.start();
    expect(isObserved()).toBe(true);

    const shutdown = pipeline.shutdown();
    await vi.runAllTimersAsync();
    await shutdown;

    expect(isObserved()).toBe(false);
  });

  it("detaches from the provider on force shutdown", () => {
    const { embeddings, isObserved } = makeEmbeddings(REMOTE);
    pipeline = makePipeline(embeddings, tunerFor());
    pipeline.start();
    pipeline.forceShutdown();
    expect(isObserved()).toBe(false);
  });

  it("downshifts on a batch-level rejection that no single chunk reproduces", async () => {
    const { embeddings } = makeEmbeddings(REMOTE);
    embeddings.embedBatch.mockImplementation(async (texts: string[]) => {
      if (texts.length > 4) throw new OllamaContextOverflowError(REMOTE, 400, "batch rejected");
      return texts.map(() => ({ embedding: [1, 2, 3], dimensions: 3 }));
    });
    const markFailed = vi.fn().mockResolvedValue(undefined);
    pipeline = makePipeline(embeddings, tunerFor());
    pipeline.setQuarantineStore({ markFailed } as unknown as QuarantineStore);
    pipeline.start();

    for (let i = 0; i < 8; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);
    embeddings.embedBatch.mockClear();
    for (let i = 8; i < 16; i++) pipeline.addChunk(chunk(i), `c${i}`, "/base");
    await settle(pipeline);

    expect(markFailed).not.toHaveBeenCalled();
    expect(sentSizes(embeddings)).toEqual([4, 4]);
  });

  it("runs the worker pool at the tuner's concurrency, a loopback endpoint included", async () => {
    for (const [seedConcurrency, expected] of [
      [undefined, 2],
      [1, 1],
    ] as const) {
      const { embeddings } = makeEmbeddings(LOCAL);
      embeddings.embedBatch.mockImplementation(async () => new Promise(() => {})); // never resolves
      const p = makePipeline(embeddings, tunerFor(2, seedConcurrency));
      p.start();
      for (let i = 0; i < 6; i++) p.addChunk(chunk(i), `c${i}`, "/base");
      await vi.advanceTimersByTimeAsync(10);
      expect(embeddings.embedBatch).toHaveBeenCalledTimes(expected);
      p.forceShutdown();
    }
  });

  it("logs each adaptation to the pipeline debug log", async () => {
    const step = vi.spyOn(pipelineLog, "step");
    const { embeddings } = makeEmbeddings(LOCAL);
    pipeline = makePipeline(embeddings, tunerFor(4, 1));
    pipeline.start();

    expect(step).toHaveBeenCalledWith(
      expect.anything(),
      "EMBED_TUNE_ADAPTED",
      expect.objectContaining({ kind: "batchSize", from: 8, to: 4, reason: "seed" }),
    );
    expect(step).toHaveBeenCalledWith(
      expect.anything(),
      "EMBED_TUNE_ADAPTED",
      expect.objectContaining({ kind: "concurrency", from: 2, to: 1, reason: "seed" }),
    );
    step.mockRestore();
  });

  it("feeds each successful embed to the tuner as chars over duration", async () => {
    const { embeddings } = makeEmbeddings(REMOTE);
    const tuner = tunerFor(4);
    const observe = vi.spyOn(tuner, "observe");
    pipeline = makePipeline(embeddings, tuner);
    pipeline.start();

    pipeline.addChunk(chunk(1, "aaaa"), "c1", "/base");
    pipeline.addChunk(chunk(2, "bb"), "c2", "/base");
    pipeline.addChunk(chunk(3, "c"), "c3", "/base");
    pipeline.addChunk(chunk(4, "ddd"), "c4", "/base");
    await settle(pipeline);

    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({ size: 4, inputChars: 10, ok: true, endpoint: { url: REMOTE, model: "jina" } }),
    );
  });
});
