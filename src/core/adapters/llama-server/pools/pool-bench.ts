// Copyright (c) 2026 Arthur Korochansky
// SPDX-License-Identifier: MIT

/**
 * Throughput bench of a managed llama-server pool: embed one fixed synthetic
 * corpus at 1..K instances and pick the instance count `--instances auto`
 * starts. Pools, the embed call and the clock are injected so tests measure a
 * fake pool on a fake clock.
 */

import { LlamaServerPoolBenchError } from "./errors.js";
import type { LlamaServerPools } from "./llama-server-pools.js";

/** Texts in the bench corpus: enough batches to keep every slot of 4 instances busy. */
export const BENCH_CORPUS_SIZE = 512;

/** A pool below two instances leaves the embedding provider no endpoint to fail over to. */
const MIN_CHOSEN_INSTANCES = 2;

/** A count whose throughput is within this fraction of the best counts as the best. */
const CHOICE_TOLERANCE = 0.05;

const BENCH_CORPUS_TEXT_LENGTH = 600;

/** Texts per `/v1/embeddings` request of the production bench embed. */
const DEFAULT_BENCH_BATCH_SIZE = 8;

export interface LlamaServerPoolThroughputSample {
  instances: number;
  textsPerSecond: number;
}

/** Embed `texts` across `endpoints`; resolves once every text is embedded. */
export type LlamaServerPoolBenchEmbed = (endpoints: string[], texts: string[]) => Promise<void>;

const CORPUS_VERBS = ["load", "parse", "resolve", "merge", "flush", "index", "score", "split"];
const CORPUS_NOUNS = ["chunk", "symbol", "record", "payload", "edge", "batch", "signal", "token"];

/** One code-like text, unique per `i`, padded with statements to the target length. */
function benchCorpusText(i: number): string {
  const verb = CORPUS_VERBS[i % CORPUS_VERBS.length];
  const noun = CORPUS_NOUNS[Math.floor(i / CORPUS_VERBS.length) % CORPUS_NOUNS.length];
  const lines = [`export function ${verb}${noun[0].toUpperCase()}${noun.slice(1)}${i}(items: ${noun}[]): number {`];
  for (let step = 0; lines.join("\n").length < BENCH_CORPUS_TEXT_LENGTH - 2; step++) {
    lines.push(`  const ${noun}${step} = items.filter((x) => x.weight > ${(i * 7 + step) % 97}).length + ${step};`);
  }
  lines.push("}");
  return lines.join("\n").slice(0, BENCH_CORPUS_TEXT_LENGTH);
}

/** The fixed synthetic corpus: {@link BENCH_CORPUS_SIZE} distinct ~600-char code texts, identical on every call. */
export function buildPoolBenchCorpus(): string[] {
  return Array.from({ length: BENCH_CORPUS_SIZE }, (_, i) => benchCorpusText(i));
}

/** Highest instance count the bench tries: Apple Silicon's unified memory carries 4, other hosts 3. */
export function defaultPoolBenchMaxInstances(host: { platform: string; arch: string }): number {
  return host.platform === "darwin" && host.arch === "arm64" ? 4 : 3;
}

/**
 * The production bench embed: `slots` concurrent `POST /v1/embeddings` per
 * endpoint, each carrying up to `batchSize` texts pulled from one shared queue.
 */
export function createLlamaServerPoolBenchEmbed(o: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  slots: number;
  batchSize?: number;
}): LlamaServerPoolBenchEmbed {
  const batchSize = o.batchSize ?? DEFAULT_BENCH_BATCH_SIZE;
  return async (endpoints, texts) => {
    let next = 0;
    const postBatches = async (endpoint: string): Promise<void> => {
      while (next < texts.length) {
        const batch = texts.slice(next, next + batchSize);
        next += batch.length;
        let response: Response;
        try {
          response = await o.fetch(`${endpoint}/v1/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: batch }),
          });
        } catch (error) {
          throw new LlamaServerPoolBenchError(endpoint, "request failed", error instanceof Error ? error : undefined);
        }
        if (!response.ok) throw new LlamaServerPoolBenchError(endpoint, `HTTP ${response.status}`);
        await response.arrayBuffer();
      }
    };
    await Promise.all(
      endpoints.flatMap((endpoint) => Array.from({ length: o.slots }, async () => postBatches(endpoint))),
    );
  };
}

/**
 * Start a pool at each count 1..maxInstances, embed the corpus once untimed
 * (warm-up of one text per endpoint) and once timed, stop the pool, and report
 * texts/s per count. The pool is stopped even when the embed fails.
 */
export async function benchPoolThroughput(
  o: { model: string; maxInstances: number; slots: number; gpuLayers: number; flashAttention: boolean },
  deps: {
    pools: Pick<LlamaServerPools, "start" | "stop" | "endpointsFor">;
    embed: LlamaServerPoolBenchEmbed;
    now: () => number;
  },
): Promise<LlamaServerPoolThroughputSample[]> {
  const corpus = buildPoolBenchCorpus();
  const samples: LlamaServerPoolThroughputSample[] = [];
  for (let instances = 1; instances <= o.maxInstances; instances++) {
    const record = await deps.pools.start({
      model: o.model,
      instances,
      slots: o.slots,
      gpuLayers: o.gpuLayers,
      flashAttention: o.flashAttention,
    });
    try {
      const endpoints = deps.pools.endpointsFor(record);
      await deps.embed(endpoints, corpus.slice(0, endpoints.length));
      const startedAt = deps.now();
      await deps.embed(endpoints, corpus);
      const elapsedSeconds = Math.max(deps.now() - startedAt, 1) / 1000;
      samples.push({ instances, textsPerSecond: corpus.length / elapsedSeconds });
    } finally {
      await deps.pools.stop(o.model);
    }
  }
  return samples;
}

/** Smallest count within 5% of the best, never below 2. */
export function chooseInstanceCount(results: LlamaServerPoolThroughputSample[]): number {
  if (results.length === 0) return MIN_CHOSEN_INSTANCES;
  const best = Math.max(...results.map((r) => r.textsPerSecond));
  const nearBest = results.filter((r) => r.textsPerSecond > best * (1 - CHOICE_TOLERANCE)).map((r) => r.instances);
  return Math.max(MIN_CHOSEN_INSTANCES, Math.min(...nearBest));
}
