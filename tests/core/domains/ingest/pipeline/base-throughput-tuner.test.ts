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
import type { EmbeddingEndpointThroughputOptimum } from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
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
