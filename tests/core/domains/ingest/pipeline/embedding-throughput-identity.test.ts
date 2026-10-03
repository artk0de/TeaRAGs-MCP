/**
 * A stored embedding throughput optimum belongs to ONE embedding identity —
 * provider + model + the endpoint SET a batch fans out over (bd
 * tea-rags-mcp-y1ynz). Before, the key was the first healthy endpoint URL +
 * model: a llama-server cluster that grew from 3 to 4 GPUs kept the 3-GPU
 * concurrency, and a provider swap on the same URL + model (an OpenAI-compatible
 * client pointed at llama-server, then the llama-server provider) inherited the
 * other client's batch shape. When the identity changes the stored optimum is
 * not applied and the tuner starts fresh.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LlamaServerEmbeddings } from "../../../../../src/core/adapters/embeddings/llama-server/provider.js";
import {
  embeddingThroughputOptimumKey,
  type EmbeddingThroughputOptimum,
} from "../../../../../src/core/contracts/types/registry.js";
import { ChunkPipeline } from "../../../../../src/core/domains/ingest/pipeline/chunk-pipeline.js";
import {
  EmbeddingThroughputTuner,
  type EmbeddingEndpointIdentity,
} from "../../../../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { StaticPayloadBuilder } from "../../../../../src/core/domains/trajectory/static/provider.js";

const GPU_A = "http://gpu-a:8080";
const GPU_B = "http://gpu-b:8080";
const MODEL = "CodeRankEmbed";

function optimum(batchSize: number, concurrency: number, settledAt = "2026-10-02T00:00:00.000Z") {
  return { batchSize, concurrency, charsPerSecond: 50_000, settledAt } satisfies EmbeddingThroughputOptimum;
}

describe("embeddingThroughputOptimumKey — embedding identity", () => {
  it("separates two providers on the same endpoint and model", () => {
    expect(embeddingThroughputOptimumKey(GPU_A, MODEL, "llama-server")).not.toBe(
      embeddingThroughputOptimumKey(GPU_A, MODEL, "openai"),
    );
  });

  it("never matches a legacy key written without a provider", () => {
    expect(embeddingThroughputOptimumKey(GPU_A, MODEL, "llama-server")).not.toBe(
      embeddingThroughputOptimumKey(GPU_A, MODEL),
    );
  });
});

describe("CollectionRegistry#readEmbeddingThroughputOptimum — embedding identity", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-identity-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function storeOptima(r: CollectionRegistry, optima: Record<string, EmbeddingThroughputOptimum>): void {
    r.recordEmbeddingThroughputOptima(Object.entries(optima).map(([key, optimum]) => ({ key, optimum })));
  }

  it("does not hand another provider's optimum, nor a provider-less legacy one, to a llama-server run", () => {
    const r = new CollectionRegistry(dir);
    storeOptima(r, {
      [embeddingThroughputOptimumKey(GPU_A, MODEL, "ollama")]: optimum(256, 2),
      [embeddingThroughputOptimumKey(GPU_A, MODEL)]: optimum(256, 2),
    });
    expect(r.readEmbeddingThroughputOptimum(GPU_A, MODEL, "llama-server")).toBeUndefined();
  });

  it("hands the matching identity's optimum back", () => {
    const r = new CollectionRegistry(dir);
    storeOptima(r, { [embeddingThroughputOptimumKey(GPU_A, MODEL, "llama-server")]: optimum(128, 8) });
    expect(r.readEmbeddingThroughputOptimum(GPU_A, MODEL, "llama-server")).toEqual(optimum(128, 8));
  });
});

describe("EmbeddingThroughputTuner — embedding identity", () => {
  it("does not seed an identity from another provider's stored optimum", () => {
    const stored = optimum(64, 2);
    const seen: EmbeddingEndpointIdentity[] = [];
    const tuner = new EmbeddingThroughputTuner({
      ceiling: 256,
      floor: 16,
      configuredConcurrency: 8,
      initialConcurrency: 1,
      seed: (endpoint) => {
        seen.push(endpoint);
        return endpoint.provider === "ollama" ? stored.batchSize : undefined;
      },
      seedConcurrency: (endpoint) => (endpoint.provider === "ollama" ? stored.concurrency : undefined),
    });

    expect(tuner.begin({ provider: "ollama", url: GPU_A, model: MODEL })).toEqual({ batchSize: 64, concurrency: 2 });
    expect(tuner.begin({ provider: "llama-server", url: GPU_A, model: MODEL })).toEqual({
      batchSize: 256,
      concurrency: 1,
    });
    expect(seen.map((endpoint) => endpoint.provider)).toEqual(["ollama", "llama-server"]);
  });
});

describe("ChunkPipeline — the identity it tunes against", () => {
  it("keys the tuner on provider + the provider's endpoint set + model", async () => {
    const seen: EmbeddingEndpointIdentity[] = [];
    const tuner = new EmbeddingThroughputTuner({
      ceiling: 8,
      floor: 1,
      configuredConcurrency: 2,
      samplesPerSize: 1000,
      seed: (endpoint) => {
        seen.push(endpoint);
        return undefined;
      },
    });
    const embeddings = {
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => ({ embedding: [1, 2, 3], dimensions: 3 }))),
      embed: vi.fn(),
      getDimensions: () => 3,
      getModel: () => MODEL,
      getProviderName: () => "llama-server",
      getBaseUrl: () => GPU_A,
      getThroughputTuneEndpointUrl: () => `${GPU_A},${GPU_B}`,
    };
    const pipeline = new ChunkPipeline(
      { addPointsOptimized: vi.fn(async () => undefined) } as never,
      embeddings as never,
      "test_collection",
      new StaticPayloadBuilder(),
      {
        workerPool: { concurrency: 1, maxRetries: 0, retryBaseDelayMs: 10, retryMaxDelayMs: 10 },
        accumulator: { batchSize: 8, flushTimeoutMs: 100, maxQueueSize: 16 },
        enableHybrid: false,
        throughputTuner: tuner,
      },
    );
    pipeline.start();
    await pipeline.shutdown();

    expect(seen[0]).toEqual({ provider: "llama-server", url: `${GPU_A},${GPU_B}`, model: MODEL });
  });
});

describe("LlamaServerEmbeddings#getThroughputTuneEndpointUrl", () => {
  const FALLBACK = "http://127.0.0.1:8080";
  const provider = () =>
    new LlamaServerEmbeddings(MODEL, 768, {}, `${GPU_A},${GPU_B}`, FALLBACK, undefined, {
      fetch: async () => {
        throw new Error("no network in this test");
      },
      setInterval: () => 0 as unknown as NodeJS.Timeout,
      clearInterval: () => {},
      log: () => {},
    });

  it("answers with the whole peer set a batch fans out over, not the first peer", () => {
    expect(provider().getThroughputTuneEndpointUrl()).toBe(`${GPU_A},${GPU_B}`);
  });

  it("maps a single peer's URL to its set, so a failure on one peer stays on the set's tuning state", () => {
    expect(provider().getThroughputTuneEndpointUrl(GPU_B)).toBe(`${GPU_A},${GPU_B}`);
  });

  it("maps a fallback URL to the fallback set", () => {
    expect(provider().getThroughputTuneEndpointUrl(FALLBACK)).toBe(FALLBACK);
  });
});
