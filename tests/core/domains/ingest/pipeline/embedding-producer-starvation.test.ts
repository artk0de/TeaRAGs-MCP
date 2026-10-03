/**
 * Producer-starved vs server-bound embedding (bd tea-rags-mcp-y1ynz).
 *
 * Live: taxdome on a 16-slot llama-server cluster embedded 33–150 texts per
 * call, every batch flushed by the formation timeout below its 256 target. When
 * the chunk producer cannot fill a batch while an embed slot is idle, more
 * concurrency buys nothing and the low chars/s is not the server's ceiling. A
 * batch flushed by the timeout below target while the worker pool had a free
 * slot and nothing queued is PRODUCER-STARVED; a run whose batches are mostly
 * starved holds the concurrency climb (no probe, no settle, so no stored value
 * moves) and says so in its result.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionRegistryPort, RecordEntryInput } from "../../../../../src/core/contracts/types/registry.js";
import { BaseIndexingPipeline, type PipelineTuning } from "../../../../../src/core/domains/ingest/pipeline/base.js";
import { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import {
  EmbeddingThroughputTuner,
  type EmbeddingEndpointIdentity,
  type EmbeddingThroughputAdaptation,
} from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
import { BatchAccumulator } from "../../../../../src/core/domains/ingest/pipeline/infra/batch-accumulator.js";
import { pipelineLog } from "../../../../../src/core/domains/ingest/pipeline/infra/debug-logger.js";
import {
  buildPipelineConfig,
  type Batch,
  type ChunkItem,
  type WorkItem,
} from "../../../../../src/core/domains/ingest/pipeline/types.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

const CLUSTER: EmbeddingEndpointIdentity = {
  provider: "llama-server",
  url: "http://gpu-a:8080,http://gpu-b:8080",
  model: "CodeRankEmbed",
};
const CHARS = 1000;

describe("BatchAccumulator — what flushed a batch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("marks a batch flushed by reaching its size as `size`", () => {
    const batches: Batch<WorkItem>[] = [];
    const acc = new BatchAccumulator({ batchSize: 2, flushTimeoutMs: 100, maxQueueSize: 4 }, "upsert", (b) =>
      batches.push(b),
    );
    acc.add({ type: "upsert", id: "a" });
    acc.add({ type: "upsert", id: "b" });
    expect(batches[0].flushTrigger).toBe("size");
  });

  it("marks a partial batch flushed by the formation timeout as `timeout`", () => {
    vi.useFakeTimers();
    const batches: Batch<WorkItem>[] = [];
    const acc = new BatchAccumulator(
      { batchSize: 8, minBatchSize: 1, flushTimeoutMs: 100, maxQueueSize: 4 },
      "upsert",
      (b) => batches.push(b),
    );
    acc.add({ type: "upsert", id: "a" });
    vi.advanceTimersByTime(150);
    expect(batches[0]).toMatchObject({ flushTrigger: "timeout" });
    expect(batches[0].items).toHaveLength(1);
  });

  it("marks the tail a drain forces out as `drain`", () => {
    const batches: Batch<WorkItem>[] = [];
    const acc = new BatchAccumulator({ batchSize: 8, flushTimeoutMs: 100, maxQueueSize: 4 }, "upsert", (b) =>
      batches.push(b),
    );
    acc.add({ type: "upsert", id: "a" });
    acc.drain();
    expect(batches[0].flushTrigger).toBe("drain");
  });
});

describe("EmbeddingThroughputTuner — producer starvation", () => {
  let clock: number;

  function settledTuner() {
    clock = Date.parse("2026-10-03T00:00:00.000Z");
    const drained: EmbeddingThroughputAdaptation[] = [];
    const tuner = new EmbeddingThroughputTuner({
      ceiling: 64,
      floor: 32,
      configuredConcurrency: 8,
      initialConcurrency: 2,
      samplesPerSize: 3,
      reprobeAfterBatches: 10_000,
      now: () => clock,
      seed: () => 64,
      seedConcurrency: () => 2,
    });
    tuner.begin(CLUSTER);
    // Settle the size at 64: it and its only neighbour (32) measure the same.
    for (const size of [64, 64, 64, 32, 32, 32]) {
      clock += 100;
      tuner.observe({ size, inputChars: size * CHARS, durationMs: size, ok: true, endpoint: CLUSTER });
    }
    expect(tuner.decision()).toEqual({ batchSize: 64, concurrency: 2 });
    return {
      tuner,
      adaptations: () => {
        drained.push(...tuner.drainAdaptations());
        return drained;
      },
      /** One full batch at the settled size, plus `starved` timeout-flushed partial ones. */
      round(starved: number): void {
        clock += 100;
        tuner.observe({
          size: 64,
          inputChars: 64 * CHARS,
          durationMs: 64,
          startedAt: clock - 64,
          ok: true,
          endpoint: CLUSTER,
          producerStarved: false,
        });
        for (let i = 0; i < starved; i++) {
          clock += 100;
          tuner.observe({
            size: 20,
            inputChars: 20 * CHARS,
            durationMs: 20,
            startedAt: clock - 20,
            ok: true,
            endpoint: CLUSTER,
            producerStarved: true,
          });
        }
      },
    };
  }

  it("climbs concurrency when the producer keeps up (control)", () => {
    const { tuner, round } = settledTuner();
    for (let i = 0; i < 8; i++) round(0);
    expect(tuner.decision().concurrency).not.toBe(2);
  });

  it("holds the concurrency climb while most batches are producer-starved", () => {
    const { tuner, round } = settledTuner();
    for (let i = 0; i < 8; i++) round(2);
    expect(tuner.decision().concurrency).toBe(2);
  });

  it("logs the hold once, as a `producer-starved` adaptation", () => {
    const { round, adaptations } = settledTuner();
    for (let i = 0; i < 8; i++) round(2);
    const holds = adaptations().filter((a) => a.reason === "producer-starved");
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ kind: "concurrency", to: 2 });
  });

  it("never lowers the stored concurrency because of starvation", () => {
    const { tuner, round } = settledTuner();
    for (let i = 0; i < 8; i++) round(2);
    expect(tuner.settledOptima()[0].optimum.concurrency).toBe(2);
  });

  it("resumes the climb once the producer catches up", () => {
    const { tuner, round } = settledTuner();
    for (let i = 0; i < 8; i++) round(2);
    for (let i = 0; i < 24; i++) round(0);
    expect(tuner.decision().concurrency).not.toBe(2);
  });

  it("writes no optimum at all for a run that never formed a full batch", () => {
    clock = Date.parse("2026-10-03T00:00:00.000Z");
    const tuner = new EmbeddingThroughputTuner({
      ceiling: 256,
      floor: 16,
      configuredConcurrency: 8,
      initialConcurrency: 8,
      samplesPerSize: 3,
      now: () => clock,
    });
    tuner.begin(CLUSTER);
    for (let i = 0; i < 50; i++) {
      clock += 100;
      tuner.observe({
        size: 40,
        inputChars: 40 * CHARS,
        durationMs: 40,
        ok: true,
        endpoint: CLUSTER,
        producerStarved: true,
      });
    }
    expect(tuner.settledOptima()).toEqual([]);
  });
});

function chunk(id: number): ChunkItem["chunk"] {
  return {
    content: `content ${id}`,
    startLine: id,
    endLine: id + 1,
    metadata: { filePath: `/base/file${id}.ts`, language: "typescript", chunkIndex: id },
  };
}

function embeddingsMock() {
  return {
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 2, 3], dimensions: 3 }))),
    embed: vi.fn(),
    getDimensions: () => 3,
    getModel: () => "CodeRankEmbed",
    getProviderName: () => "llama-server",
    getBaseUrl: () => "http://gpu-a:8080",
  };
}

function pipelineWith(batchSize: number) {
  return new ChunkPipeline(
    { addPointsOptimized: vi.fn(async () => undefined) } as never,
    embeddingsMock() as never,
    "test_collection",
    new StaticPayloadBuilder(),
    {
      workerPool: { concurrency: 4, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 10 },
      accumulator: { batchSize, minBatchSize: 1, flushTimeoutMs: 20, maxQueueSize: 16 },
      enableHybrid: false,
    },
  );
}

describe("ChunkPipeline — producer starvation of the embed stage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("counts timeout-flushed partial batches formed while a slot was idle as starved", async () => {
    const pipeline = pipelineWith(64);
    pipeline.start();
    for (let wave = 0; wave < 3; wave++) {
      pipeline.addChunk(chunk(wave), `id-${wave}`, "/base");
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    await pipeline.shutdown();
    expect(pipeline.embeddingProducerStarvation()).toEqual({
      formedBatches: 3,
      starvedBatches: 3,
      producerStarved: true,
    });
  });

  it("counts batches that reached their size as not starved", async () => {
    const pipeline = pipelineWith(2);
    pipeline.start();
    for (let i = 0; i < 6; i++) pipeline.addChunk(chunk(i), `id-${i}`, "/base");
    await pipeline.shutdown();
    expect(pipeline.embeddingProducerStarvation()).toEqual({
      formedBatches: 3,
      starvedBatches: 0,
      producerStarved: false,
    });
  });

  it("writes the run's starvation verdict to the pipeline debug log at shutdown", async () => {
    const step = vi.spyOn(pipelineLog, "step");
    const pipeline = pipelineWith(64);
    pipeline.start();
    pipeline.addChunk(chunk(1), "id-1", "/base");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await pipeline.shutdown();
    expect(step).toHaveBeenCalledWith(
      expect.anything(),
      "EMBED_PRODUCER_STARVATION",
      expect.objectContaining({ formedBatches: 1, starvedBatches: 1, producerStarved: true }),
    );
  });
});

describe("producer starvation in the run's registry entry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-starved-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const tuning: PipelineTuning = {
    pipelineConfig: buildPipelineConfig(
      1,
      { batchSize: 256, batchTimeoutMs: 2000 },
      { deleteConcurrency: 8, deleteBatchSize: 500, deleteFlushTimeoutMs: 1000 },
    ),
    chunkerPoolSize: 1,
    fileConcurrency: 1,
  };

  class RecordProbePipeline extends BaseIndexingPipeline {
    constructor(registry: CollectionRegistryPort) {
      super(
        {
          countPoints: async () => 0,
          getCollectionInfo: async () => ({ vectorSize: 768 }),
          isEmbedded: false,
          url: "http://localhost:6333",
        } as never,
        embeddingsMock() as never,
        {} as never,
        {} as never,
        { snapshotDir: "/tmp" } as never,
        tuning,
        { registry },
      );
    }

    async record(): Promise<void> {
      await this.recordRegistryEntry("code_27622aef", "/nonexistent-repo-y1ynz", [], {
        formedBatches: 40,
        starvedBatches: 31,
        producerStarved: true,
      });
    }
  }

  it("records the verdict, and the registry reads it back for the collection", async () => {
    const recorded: RecordEntryInput[] = [];
    await new RecordProbePipeline({ record: (entry) => recorded.push(entry) }).record();
    expect(recorded[0].embeddingProducerStarvation).toEqual({
      formedBatches: 40,
      starvedBatches: 31,
      producerStarved: true,
    });

    const registry = new CollectionRegistry(dir);
    registry.record(recorded[0]);
    expect(new CollectionRegistry(dir).readEmbeddingProducerStarvation("code_27622aef")).toEqual({
      formedBatches: 40,
      starvedBatches: 31,
      producerStarved: true,
    });
  });
});
