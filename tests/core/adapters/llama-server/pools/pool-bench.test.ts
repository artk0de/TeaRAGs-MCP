import { describe, expect, it, vi } from "vitest";

import {
  BENCH_CORPUS_SIZE,
  benchPoolThroughput,
  buildPoolBenchCorpus,
  chooseInstanceCount,
  createLlamaServerPoolBenchEmbed,
  defaultPoolBenchMaxInstances,
} from "../../../../../src/core/adapters/llama-server/pools/pool-bench.js";

const MODEL = "jinaai/jina-embeddings-v2-base-code";

function recordFor(instances: number) {
  return {
    model: MODEL,
    ggufPath: "/d/m.gguf",
    binary: "/d/llama-server",
    instances: Array.from({ length: instances }, (_, i) => ({ pid: 100 + i, port: 21000 + i, logPath: `/d/${i}.log` })),
    args: [],
    startedAt: "2026-11-02T00:00:00.000Z",
  };
}

describe("chooseInstanceCount", () => {
  it("takes the smallest count within 5% of the best", () => {
    expect(
      chooseInstanceCount([
        { instances: 1, textsPerSecond: 100 },
        { instances: 2, textsPerSecond: 190 },
        { instances: 3, textsPerSecond: 198 },
        { instances: 4, textsPerSecond: 200 },
      ]),
    ).toBe(3);
  });

  it("never returns fewer than 2 instances", () => {
    expect(
      chooseInstanceCount([
        { instances: 1, textsPerSecond: 100 },
        { instances: 2, textsPerSecond: 101 },
      ]),
    ).toBe(2);
  });

  it("returns 2 when there are no results to choose from", () => {
    expect(chooseInstanceCount([])).toBe(2);
  });
});

describe("buildPoolBenchCorpus", () => {
  it("is BENCH_CORPUS_SIZE deterministic code-like texts of ~600 chars", () => {
    const corpus = buildPoolBenchCorpus();

    expect(corpus).toHaveLength(BENCH_CORPUS_SIZE);
    expect(buildPoolBenchCorpus()).toEqual(corpus);
    expect(new Set(corpus).size).toBe(BENCH_CORPUS_SIZE);
    for (const text of corpus) {
      expect(text.length).toBeGreaterThanOrEqual(500);
      expect(text.length).toBeLessThanOrEqual(700);
    }
  });
});

describe("defaultPoolBenchMaxInstances", () => {
  it("is 4 on Apple Silicon and 3 elsewhere", () => {
    expect(defaultPoolBenchMaxInstances({ platform: "darwin", arch: "arm64" })).toBe(4);
    expect(defaultPoolBenchMaxInstances({ platform: "darwin", arch: "x64" })).toBe(3);
    expect(defaultPoolBenchMaxInstances({ platform: "linux", arch: "arm64" })).toBe(3);
  });
});

describe("benchPoolThroughput", () => {
  it("starts and stops a pool per instance count and times the corpus embed on each", async () => {
    let clock = 0;
    const events: string[] = [];
    const pools = {
      start: vi.fn(async (o: { instances: number }) => {
        events.push(`start ${o.instances}`);
        return recordFor(o.instances);
      }),
      stop: vi.fn(async (model?: string) => {
        events.push(`stop ${model}`);
      }),
      endpointsFor: (record: ReturnType<typeof recordFor>) => record.instances.map((i) => `http://127.0.0.1:${i.port}`),
    };
    const timedEmbeds: { endpoints: number; texts: number }[] = [];
    const embed = vi.fn(async (endpoints: string[], texts: string[]) => {
      if (texts.length === BENCH_CORPUS_SIZE) {
        timedEmbeds.push({ endpoints: endpoints.length, texts: texts.length });
        // 1 instance: 4 s, 2 instances: 2 s, 3 instances: 1 s.
        clock += 4000 / 2 ** (endpoints.length - 1);
      }
    });

    const results = await benchPoolThroughput(
      { model: MODEL, maxInstances: 3, slots: 4, gpuLayers: 999, flashAttention: true },
      { pools, embed, now: () => clock },
    );

    expect(results).toEqual([
      { instances: 1, textsPerSecond: BENCH_CORPUS_SIZE / 4 },
      { instances: 2, textsPerSecond: BENCH_CORPUS_SIZE / 2 },
      { instances: 3, textsPerSecond: BENCH_CORPUS_SIZE },
    ]);
    expect(events).toEqual([`start 1`, `stop ${MODEL}`, `start 2`, `stop ${MODEL}`, `start 3`, `stop ${MODEL}`]);
    expect(pools.start).toHaveBeenCalledWith({
      model: MODEL,
      instances: 2,
      slots: 4,
      gpuLayers: 999,
      flashAttention: true,
    });
    expect(timedEmbeds).toEqual([
      { endpoints: 1, texts: BENCH_CORPUS_SIZE },
      { endpoints: 2, texts: BENCH_CORPUS_SIZE },
      { endpoints: 3, texts: BENCH_CORPUS_SIZE },
    ]);
  });

  it("stops the pool when the embed fails", async () => {
    const pools = {
      start: vi.fn(async (o: { instances: number }) => recordFor(o.instances)),
      stop: vi.fn(async () => {}),
      endpointsFor: () => ["http://127.0.0.1:21000"],
    };

    await expect(
      benchPoolThroughput(
        { model: MODEL, maxInstances: 2, slots: 4, gpuLayers: 999, flashAttention: true },
        {
          pools,
          embed: async () => {
            throw new Error("boom");
          },
          now: () => 0,
        },
      ),
    ).rejects.toThrow("boom");
    expect(pools.stop).toHaveBeenCalledWith(MODEL);
  });
});

describe("createLlamaServerPoolBenchEmbed", () => {
  it("posts every text once across the endpoints in batches, at most slots requests per endpoint at a time", async () => {
    const seen: string[] = [];
    const inFlight = new Map<string, number>();
    let maxInFlight = 0;
    const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
      const endpoint = url.replace("/v1/embeddings", "");
      inFlight.set(endpoint, (inFlight.get(endpoint) ?? 0) + 1);
      maxInFlight = Math.max(maxInFlight, inFlight.get(endpoint) ?? 0);
      await new Promise((resolve) => setTimeout(resolve, 1));
      const body = JSON.parse(init.body as string) as { input: string[] };
      expect(body.input.length).toBeLessThanOrEqual(8);
      seen.push(...body.input);
      inFlight.set(endpoint, (inFlight.get(endpoint) ?? 1) - 1);
      return new Response(JSON.stringify({ data: body.input.map(() => ({ embedding: [0] })) }), { status: 200 });
    });
    const embed = createLlamaServerPoolBenchEmbed({ fetch: fetchFn, slots: 2, batchSize: 8 });
    const texts = Array.from({ length: 100 }, (_, i) => `text ${i}`);

    await embed(["http://127.0.0.1:21000", "http://127.0.0.1:21001"], texts);

    expect([...seen].sort()).toEqual([...texts].sort());
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(new Set(fetchFn.mock.calls.map(([u]) => u))).toEqual(
      new Set(["http://127.0.0.1:21000/v1/embeddings", "http://127.0.0.1:21001/v1/embeddings"]),
    );
  });

  it("rejects when an endpoint answers a non-2xx status", async () => {
    const embed = createLlamaServerPoolBenchEmbed({
      fetch: async () => new Response("nope", { status: 500 }),
      slots: 1,
    });

    await expect(embed(["http://127.0.0.1:21000"], ["a"])).rejects.toThrow(/500/);
  });
});
