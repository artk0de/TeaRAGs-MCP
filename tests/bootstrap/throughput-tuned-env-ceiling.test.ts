/**
 * The concurrency ceiling of the embedding throughput tuner comes from the
 * CURRENT invocation, never from a registry stamp (bd tea-rags-mcp-y1ynz).
 *
 * Live: taxdome's entry carried `INGEST_PIPELINE_CONCURRENCY=2` and a 100 ms
 * batch timeout stamped in its single-slot Ollama era. Every later run replayed
 * them into its env, `parseAppConfigZod` read the replayed value as a user
 * setting, and `buildPipelineConfig` made 2 the hard ceiling of the climb — on
 * a 16-slot llama-server cluster, at ~10% of its capacity.
 *
 * The chain under test is the real one an index run takes: registry entry →
 * `resolveRegistryEnv` → env merged under the invocation env → parse →
 * pipeline config.
 */
import { describe, expect, it } from "vitest";

import { parseAppConfigZod } from "../../src/bootstrap/config/parse.js";
import type { CollectionEntry } from "../../src/core/contracts/types/registry.js";
import { IMPLICIT_EMBEDDING_CONCURRENCY_CEILING } from "../../src/core/domains/ingest/pipeline/embedding-throughput-tuner.js";
import { buildPipelineConfig } from "../../src/core/domains/ingest/pipeline/types.js";
import { resolveRegistryEnv } from "../../src/core/domains/maintenance/registry/env-resolution.js";

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_27622aef",
    path: "/repo/taxdome",
    name: "taxdome",
    embeddingModel: "CodeRankEmbed",
    embeddingDimensions: 768,
    qdrantUrl: "http://127.0.0.1:6333",
    indexedAt: "2026-10-01T00:00:00.000Z",
    teaRagsVersion: "1.44.0",
    chunksCount: 10,
    env: {
      EMBEDDING_PROVIDER: "llama-server",
      INGEST_PIPELINE_CONCURRENCY: "2",
      EMBEDDING_TUNE_BATCH_SIZE: "256",
      EMBEDDING_TUNE_MIN_BATCH_SIZE: "32",
      EMBEDDING_TUNE_BATCH_TIMEOUT_MS: "100",
    },
    ...over,
  };
}

/** What an index run parses: the invocation env, with the registry filling only what it leaves unset. */
function runConfig(registryEntry: CollectionEntry, invocation: Record<string, string> = {}) {
  const zod = parseAppConfigZod({ ...resolveRegistryEnv(registryEntry, invocation), ...invocation });
  return {
    zod,
    pipeline: buildPipelineConfig(zod.ingest.tune.pipelineConcurrency, zod.embedding.tune, zod.qdrantTune, {
      pipelineConcurrencyUserSet: zod.flags.userSetPipelineConcurrency,
    }),
  };
}

describe("throughput-tuned env — registry stamp vs explicit setting", () => {
  it("a stamped INGEST_PIPELINE_CONCURRENCY is not a user setting and not the climb's ceiling", () => {
    const { zod, pipeline } = runConfig(entry());
    expect(zod.flags.userSetPipelineConcurrency).toBe(false);
    expect(pipeline.embedConcurrencyCeiling).toBe(IMPLICIT_EMBEDDING_CONCURRENCY_CEILING);
  });

  it("stamped batch-shape keys fall back to the code defaults", () => {
    const { zod, pipeline } = runConfig(entry());
    expect(zod.flags.userSetBatchSize).toBe(false);
    expect(pipeline.upsertAccumulator.batchSize).toBe(256); // the llama-server provider default, not the stamp
    expect(pipeline.upsertAccumulator.flushTimeoutMs).toBe(2000);
    expect(pipeline.upsertAccumulator.minBatchSize).toBeUndefined();
  });

  it("the invocation env's INGEST_PIPELINE_CONCURRENCY IS the ceiling", () => {
    const { zod, pipeline } = runConfig(entry(), { INGEST_PIPELINE_CONCURRENCY: "4" });
    expect(zod.flags.userSetPipelineConcurrency).toBe(true);
    expect(pipeline.embedConcurrencyCeiling).toBe(4);
  });

  it("an operator pin (set-env) IS the ceiling", () => {
    const { zod, pipeline } = runConfig(
      entry({ operatorPinnedEnvKeys: ["INGEST_PIPELINE_CONCURRENCY", "EMBEDDING_TUNE_BATCH_TIMEOUT_MS"] }),
    );
    expect(zod.flags.userSetPipelineConcurrency).toBe(true);
    expect(pipeline.embedConcurrencyCeiling).toBe(2);
    expect(pipeline.upsertAccumulator.flushTimeoutMs).toBe(100);
  });
});
