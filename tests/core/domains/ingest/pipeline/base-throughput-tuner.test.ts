/**
 * BaseIndexingPipeline × embedding throughput tuning (bd tea-rags-mcp-7ju66):
 * the tuner exists only when adaptive embedding is on, takes its bounds from
 * the configured tuning, seeds from the registry's stored optimum for the
 * matching endpoint + model, and the run's settled optima land in the registry
 * entry the run records.
 */

import { describe, expect, it, vi } from "vitest";

import {
  embeddingThroughputOptimumKey,
  type CollectionRegistryPort,
  type EmbeddingThroughputOptimum,
  type RecordEntryInput,
} from "../../../../../src/core/contracts/types/registry.js";
import { BaseIndexingPipeline, type PipelineTuning } from "../../../../../src/core/domains/ingest/pipeline/base.js";
import {
  IMPLICIT_EMBEDDING_CONCURRENCY_CEILING,
  type EmbeddingEndpointThroughputOptimum,
} from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
import { buildPipelineConfig } from "../../../../../src/core/domains/ingest/pipeline/types.js";

const URL = "http://192.168.1.71:11434";

function tuning(opts: { static?: boolean; batchSize?: number; minBatchSize?: number } = {}): PipelineTuning {
  return {
    pipelineConfig: buildPipelineConfig(
      3,
      {
        batchSize: opts.batchSize ?? 256,
        ...(opts.minBatchSize !== undefined ? { minBatchSize: opts.minBatchSize } : {}),
        batchTimeoutMs: 2000,
        static: opts.static ?? false,
      },
      { deleteConcurrency: 8, deleteBatchSize: 500, deleteFlushTimeoutMs: 1000 },
    ),
    chunkerPoolSize: 1,
    fileConcurrency: 1,
  };
}

const embeddings = {
  getModel: () => "jina",
  getBaseUrl: () => URL,
  getPrimaryBaseUrl: () => URL,
  getDimensions: () => 768,
};

class TunerProbePipeline extends BaseIndexingPipeline {
  constructor(t: PipelineTuning, registry?: CollectionRegistryPort, qdrant: unknown = {}) {
    super(qdrant as never, embeddings as never, {} as never, {} as never, { snapshotDir: "/tmp" } as never, t, {
      ...(registry ? { registry } : {}),
    });
  }

  tuner() {
    return this.createThroughputTuner();
  }

  async record(optima: EmbeddingEndpointThroughputOptimum[]): Promise<void> {
    await this.recordRegistryEntry("code_abc", "/nonexistent-repo-7ju66", optima);
  }
}

function optimum(batchSize: number): EmbeddingThroughputOptimum {
  return { batchSize, concurrency: 3, charsPerSecond: 1000, settledAt: "2026-10-02T00:00:00.000Z" };
}

describe("BaseIndexingPipeline — embedding throughput tuner", () => {
  it("builds no tuner when EMBEDDING_TUNE_STATIC pins the static behaviour", () => {
    expect(new TunerProbePipeline(tuning({ static: true })).tuner()).toBeUndefined();
  });

  it("bounds the tuner by the configured batch size and the configured concurrency", () => {
    const tuner = new TunerProbePipeline(tuning({ batchSize: 256 })).tuner();
    expect(tuner?.begin({ url: URL, model: "jina" })).toEqual({ batchSize: 256, concurrency: 3 });
  });

  it("seeds from the registry's optimum for the matching endpoint + model only", () => {
    const read = vi.fn((url: string, model: string) => (url === URL && model === "jina" ? optimum(64) : undefined));
    const registry: CollectionRegistryPort = { record: vi.fn(), readEmbeddingThroughputOptimum: read };
    const tuner = new TunerProbePipeline(tuning(), registry).tuner();

    expect(tuner?.begin({ url: URL, model: "jina" }).batchSize).toBe(64);
    expect(new TunerProbePipeline(tuning(), registry).tuner()?.begin({ url: URL, model: "nomic" }).batchSize).toBe(256);
  });

  it("seeds concurrency from the registry's optimum, clamped to the configured concurrency", () => {
    const at = (concurrency: number): CollectionRegistryPort => ({
      record: vi.fn(),
      readEmbeddingThroughputOptimum: () => ({ ...optimum(64), concurrency }),
    });
    expect(new TunerProbePipeline(tuning(), at(1)).tuner()?.begin({ url: URL, model: "jina" })).toEqual({
      batchSize: 64,
      concurrency: 1,
    });
    expect(new TunerProbePipeline(tuning(), at(12)).tuner()?.begin({ url: URL, model: "jina" }).concurrency).toBe(3);
  });

  it("clamps a stored optimum to the configured bounds", () => {
    const registry: CollectionRegistryPort = {
      record: vi.fn(),
      readEmbeddingThroughputOptimum: () => optimum(4096),
    };
    expect(
      new TunerProbePipeline(tuning({ batchSize: 128 }), registry).tuner()?.begin({ url: URL, model: "jina" }),
    ).toMatchObject({ batchSize: 128 });

    const low: CollectionRegistryPort = { record: vi.fn(), readEmbeddingThroughputOptimum: () => optimum(2) };
    expect(
      new TunerProbePipeline(tuning({ batchSize: 256, minBatchSize: 32 }), low)
        .tuner()
        ?.begin({ url: URL, model: "jina" }),
    ).toMatchObject({ batchSize: 32 });
  });

  it("writes the run's settled optima into the registry entry, keyed by endpoint + model", async () => {
    const recorded: RecordEntryInput[] = [];
    const registry: CollectionRegistryPort = { record: (entry) => recorded.push(entry) };
    const qdrant = {
      countPoints: async () => 0,
      getCollectionInfo: async () => ({ vectorSize: 768 }),
      isEmbedded: false,
      url: "http://localhost:6333",
    };
    await new TunerProbePipeline(tuning(), registry, qdrant).record([
      { endpoint: { url: URL, model: "jina" }, optimum: optimum(64) },
      { endpoint: { model: "onnx-in-process" }, optimum: optimum(32) },
    ]);

    expect(recorded[0].embeddingThroughputOptima).toEqual({
      [embeddingThroughputOptimumKey(URL, "jina")]: optimum(64),
    });
  });

  it("writes no optima field when nothing settled", async () => {
    const recorded: RecordEntryInput[] = [];
    const registry: CollectionRegistryPort = { record: (entry) => recorded.push(entry) };
    const qdrant = {
      countPoints: async () => 0,
      getCollectionInfo: async () => ({ vectorSize: 768 }),
      isEmbedded: false,
      url: "http://localhost:6333",
    };
    await new TunerProbePipeline(tuning(), registry, qdrant).record([]);

    expect(recorded[0]).not.toHaveProperty("embeddingThroughputOptima");
  });
});

/**
 * Implicit concurrency ceiling: INGEST_PIPELINE_CONCURRENCY unset leaves every
 * other consumer at 1 but lets the embed concurrency climb up to
 * IMPLICIT_EMBEDDING_CONCURRENCY_CEILING; an explicit value — even 1 — stays
 * the hard ceiling and the unseeded start.
 */
describe("BaseIndexingPipeline — implicit embed concurrency ceiling", () => {
  function tuningFor(pipelineConcurrency: number, userSet: boolean, opts: { static?: boolean } = {}): PipelineTuning {
    return {
      pipelineConfig: buildPipelineConfig(
        pipelineConcurrency,
        { batchSize: 256, batchTimeoutMs: 2000, static: opts.static ?? false },
        { deleteConcurrency: 8, deleteBatchSize: 500, deleteFlushTimeoutMs: 1000 },
        { pipelineConcurrencyUserSet: userSet },
      ),
      chunkerPoolSize: 1,
      fileConcurrency: 1,
    };
  }

  const ENDPOINT = { url: URL, model: "jina" };
  const seededAt = (concurrency: number): CollectionRegistryPort => ({
    record: vi.fn(),
    readEmbeddingThroughputOptimum: () => ({ ...optimum(256), concurrency }),
  });

  /** Drive waves against a server whose per-call rate is constant, so aggregate chars/s grows with concurrency. */
  function climb(tuner: NonNullable<ReturnType<TunerProbePipeline["tuner"]>>, waves: number): number[] {
    // The pipeline's tuner reads the real clock when it opens a probe; batches
    // stamped ahead of it always count toward the probe in force.
    let clock = Date.now() + 60_000;
    const seen: number[] = [];
    for (let w = 0; w < waves; w++) {
      const { batchSize, concurrency } = tuner.decision();
      seen.push(concurrency);
      const inputChars = batchSize * 1000;
      const durationMs = 1000;
      for (let i = 0; i < concurrency; i++) {
        tuner.observe({ size: batchSize, inputChars, durationMs, startedAt: clock, ok: true, endpoint: ENDPOINT });
      }
      clock += durationMs;
    }
    return seen;
  }

  it("keeps every other consumer at 1 when unset", () => {
    const { pipelineConfig } = tuningFor(1, false);
    expect(pipelineConfig.workerPool.concurrency).toBe(1);
    expect(pipelineConfig.upsertAccumulator.maxQueueSize).toBe(2);
    expect(pipelineConfig.embedConcurrencyCeiling).toBe(IMPLICIT_EMBEDDING_CONCURRENCY_CEILING);
    expect(IMPLICIT_EMBEDDING_CONCURRENCY_CEILING).toBe(8);
  });

  it("unset: starts at 1 without a stored optimum and climbs above 1, up to the implicit ceiling", () => {
    const tuner = new TunerProbePipeline(tuningFor(1, false)).tuner()!;
    expect(tuner.begin(ENDPOINT).concurrency).toBe(1);
    const seen = climb(tuner, 120);
    expect(Math.max(...seen)).toBe(IMPLICIT_EMBEDDING_CONCURRENCY_CEILING);
    expect(tuner.decision().concurrency).toBe(IMPLICIT_EMBEDDING_CONCURRENCY_CEILING);
  });

  it("unset: starts at the stored optimum, clamped to [1, implicit ceiling]", () => {
    expect(new TunerProbePipeline(tuningFor(1, false), seededAt(4)).tuner()?.begin(ENDPOINT).concurrency).toBe(4);
    expect(new TunerProbePipeline(tuningFor(1, false), seededAt(12)).tuner()?.begin(ENDPOINT).concurrency).toBe(8);
  });

  it("explicit 2: the configured value is the hard ceiling and the unseeded start", () => {
    const tuner = new TunerProbePipeline(tuningFor(2, true)).tuner()!;
    expect(tuner.begin(ENDPOINT).concurrency).toBe(2);
    expect(Math.max(...climb(tuner, 120))).toBe(2);
    expect(new TunerProbePipeline(tuningFor(2, true), seededAt(12)).tuner()?.begin(ENDPOINT).concurrency).toBe(2);
  });

  it("explicit 1: the climb never leaves 1", () => {
    const tuner = new TunerProbePipeline(tuningFor(1, true), seededAt(6)).tuner()!;
    expect(tuner.begin(ENDPOINT).concurrency).toBe(1);
    expect(Math.max(...climb(tuner, 120))).toBe(1);
  });

  it("static mode unset: no tuner, the pool stays at 1", () => {
    const t = tuningFor(1, false, { static: true });
    expect(new TunerProbePipeline(t).tuner()).toBeUndefined();
    expect(t.pipelineConfig.workerPool.concurrency).toBe(1);
  });
});
