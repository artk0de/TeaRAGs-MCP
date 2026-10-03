import { describe, expect, it } from "vitest";

import type { RateLimitConfig } from "../../../../../src/core/adapters/embeddings/base.js";
import {
  isEmbeddingProviderUnavailable,
  isProviderRecoveryWaitSpent,
} from "../../../../../src/core/adapters/embeddings/errors.js";
import {
  LlamaServerContextOverflowError,
  LlamaServerModelMismatchError,
  LlamaServerResponseError,
  LlamaServerUnavailableError,
} from "../../../../../src/core/adapters/embeddings/llama-server/errors.js";
import {
  LlamaServerEmbeddings,
  type LlamaServerEmbeddingsDeps,
} from "../../../../../src/core/adapters/embeddings/llama-server/provider.js";

const PEER_A = "http://gpu:8081";
const PEER_B = "http://gpu:8082";
const FALLBACK = "http://127.0.0.1:8080";
const MODEL = "unclemusclez/jina-embeddings-v2-base-code:latest";

type EmbedOutcome = "refused" | "reset" | Response;

/** One fake llama-server. Every field is mutable so a test can flip it mid-run. */
interface FakeLlamaServer {
  health: boolean;
  /** `/props` body, or 404 when undefined. */
  props?: Record<string, unknown>;
  /** Override the `/v1/embeddings` answer; undefined → embed every text. */
  embed?: (texts: string[]) => EmbedOutcome | undefined;
  /** Real-time delay of every `/v1/embeddings` answer, per text in the request. */
  delayMsPerText?: number;
}

interface RecordedRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  input?: string[];
  model?: string;
}

/** Vector for "t<N>": [N, 0.5] — the first component proves reassembly order. */
function vectorFor(text: string): number[] {
  return [Number(text.replace(/\D/g, "") || "0"), 0.5];
}

function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
}

function socketReset(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

function fakeCluster(servers: Record<string, FakeLlamaServer>) {
  const requests: RecordedRequest[] = [];
  const inFlight = new Map<string, number>();
  const peakInFlight = new Map<string, number>();
  const fetchFn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const target = new URL(input instanceof Request ? input.url : input);
    const base = `${target.protocol}//${target.host}`;
    const server = servers[base];
    const method = init?.method ?? "GET";
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { input?: string[]; model?: string }) : {};
    requests.push({ url: base, path: target.pathname, method, headers, input: body.input, model: body.model });
    if (!server) throw refused();
    if (target.pathname === "/health") {
      if (!server.health) throw refused();
      return Response.json({ status: "ok" });
    }
    if (!server.health) throw refused();
    if (target.pathname === "/props") {
      return server.props ? Response.json(server.props) : new Response("Not Found", { status: 404 });
    }
    if (target.pathname === "/v1/embeddings") {
      const texts = body.input ?? [];
      if (server.delayMsPerText !== undefined) {
        const current = (inFlight.get(base) ?? 0) + 1;
        inFlight.set(base, current);
        peakInFlight.set(base, Math.max(peakInFlight.get(base) ?? 0, current));
        await new Promise((resolve) => setTimeout(resolve, (server.delayMsPerText ?? 0) * texts.length));
        inFlight.set(base, (inFlight.get(base) ?? 1) - 1);
      }
      const outcome = server.embed?.(texts);
      if (outcome === "refused") throw refused();
      if (outcome === "reset") throw socketReset();
      if (outcome) return outcome;
      return Response.json({
        object: "list",
        data: texts.map((text, index) => ({ object: "embedding", index, embedding: vectorFor(text) })),
      });
    }
    return new Response("Not Found", { status: 404 });
  };
  const embedCalls = (url?: string) =>
    requests.filter((r) => r.path === "/v1/embeddings" && (url === undefined || r.url === url));
  /** Texts one endpoint embedded (or was asked to embed). */
  const embeddedTexts = (url: string) => embedCalls(url).flatMap((r) => r.input ?? []);
  return {
    fetch: fetchFn,
    requests,
    embedCalls,
    embeddedTexts,
    peakInFlight: (url: string) => peakInFlight.get(url) ?? 0,
  };
}

function texts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `t${i}`);
}

/** Controllable clock + timers: sleep advances the clock, the probe interval is fired by hand. */
function fakeTime() {
  let now = 1_000_000;
  const intervals: (() => void)[] = [];
  const deps: Required<Pick<LlamaServerEmbeddingsDeps, "now" | "sleep" | "setInterval" | "clearInterval">> = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      intervals.length = 0;
    },
  };
  return {
    deps,
    advance(ms: number) {
      now += ms;
    },
    async fireProbe() {
      for (const fn of [...intervals]) fn();
      // Let the probe's fetches settle.
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
    intervalCount: () => intervals.length,
  };
}

function healthy(props?: Record<string, unknown>): FakeLlamaServer {
  return { health: true, props };
}

function makeProvider(
  cluster: ReturnType<typeof fakeCluster>,
  options: {
    peers?: string;
    fallbacks?: string;
    apiKey?: string;
    rateLimit?: RateLimitConfig;
    model?: string;
    dimensions?: number;
    time?: ReturnType<typeof fakeTime>;
    log?: string[];
  } = {},
): LlamaServerEmbeddings {
  const time = options.time ?? fakeTime();
  return new LlamaServerEmbeddings(
    options.model ?? MODEL,
    options.dimensions,
    { failoverConsecutiveFailures: 3, unavailableRetryMaxWaitMs: 0, ...options.rateLimit },
    options.peers ?? `${PEER_A},${PEER_B}`,
    options.fallbacks,
    options.apiKey,
    {
      fetch: cluster.fetch,
      ...time.deps,
      log: (line) => {
        (options.log ?? []).push(line);
      },
    },
  );
}

describe("LlamaServerEmbeddings", () => {
  describe("fan-out", () => {
    it("spreads one batch over both peers and returns vectors in input order", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy(), [PEER_B]: healthy() });
      const provider = makeProvider(cluster);

      const results = await provider.embedBatch(texts(8));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(results[0].dimensions).toBe(2);
      expect(cluster.embedCalls(PEER_A).length).toBeGreaterThan(0);
      expect(cluster.embedCalls(PEER_B).length).toBeGreaterThan(0);
    });

    it("keeps each endpoint's /props total_slots requests in flight, and no more", async () => {
      const cluster = fakeCluster({
        [PEER_A]: { ...healthy({ total_slots: 2 }), delayMsPerText: 2 },
        [PEER_B]: { ...healthy({ total_slots: 2 }), delayMsPerText: 2 },
      });
      const provider = makeProvider(cluster);

      await provider.embedBatch(texts(32));

      expect(cluster.peakInFlight(PEER_A)).toBe(2);
      expect(cluster.peakInFlight(PEER_B)).toBe(2);
    });

    it("treats a /props 404 as one slot and still embeds", async () => {
      const cluster = fakeCluster({
        [PEER_A]: { ...healthy(), delayMsPerText: 2 },
        [PEER_B]: { ...healthy(), delayMsPerText: 2 },
      });
      const provider = makeProvider(cluster);

      const results = await provider.embedBatch(texts(6));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5]);
      expect(cluster.peakInFlight(PEER_A)).toBe(1);
      expect(cluster.peakInFlight(PEER_B)).toBe(1);
    });

    it("sends the configured model with the input", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy() });
      const provider = makeProvider(cluster, { peers: PEER_A });

      await provider.embedBatch(["t1"]);

      expect(cluster.embedCalls(PEER_A)[0].model).toBe(MODEL);
      expect(cluster.embedCalls(PEER_A)[0].method).toBe("POST");
    });

    it("returns an empty list for an empty batch without touching the network", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy() });
      const provider = makeProvider(cluster, { peers: PEER_A });

      expect(await provider.embedBatch([])).toEqual([]);
      expect(cluster.requests).toHaveLength(0);
    });

    it("embed(text) goes through the same path", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy() });
      const provider = makeProvider(cluster, { peers: PEER_A });

      expect((await provider.embed("t42")).embedding).toEqual([42, 0.5]);
    });
  });

  describe("work stealing", () => {
    it("lets a fast endpoint drain the queue while a slow one serves a single micro-batch", async () => {
      // 40 texts, 2 slots -> 8 micro-batches of 5. A pre-split by (unmeasured,
      // equal) throughput would hand the slow endpoint 20 texts = 400ms.
      const cluster = fakeCluster({
        [PEER_A]: { ...healthy(), delayMsPerText: 1 },
        [PEER_B]: { ...healthy(), delayMsPerText: 20 },
      });
      const provider = makeProvider(cluster);

      const started = Date.now();
      const results = await provider.embedBatch(texts(40));
      const elapsedMs = Date.now() - started;

      expect(results.map((r) => r.embedding[0])).toEqual(Array.from({ length: 40 }, (_, i) => i));
      expect(cluster.embeddedTexts(PEER_B).length).toBeLessThanOrEqual(5);
      expect(cluster.embeddedTexts(PEER_A).length).toBeGreaterThanOrEqual(35);
      // The tail is one slow micro-batch (~100ms), not a proportional share (~400ms).
      expect(elapsedMs).toBeLessThan(300);
    });

    it("re-queues a micro-batch whose endpoint failed mid-batch onto the other endpoint, order intact", async () => {
      let callsOnA = 0;
      let lostOnA: string[] = [];
      const cluster = fakeCluster({
        [PEER_A]: {
          health: true,
          delayMsPerText: 1,
          embed: (input) => {
            callsOnA += 1;
            if (callsOnA < 2) return undefined;
            lostOnA = input;
            return "refused";
          },
        },
        [PEER_B]: { ...healthy(), delayMsPerText: 1 },
      });
      const provider = makeProvider(cluster);

      const results = await provider.embedBatch(texts(24));

      expect(results.map((r) => r.embedding[0])).toEqual(Array.from({ length: 24 }, (_, i) => i));
      expect(lostOnA.length).toBeGreaterThan(0);
      const servedByB = new Set(cluster.embeddedTexts(PEER_B));
      for (const text of lostOnA) expect(servedByB.has(text)).toBe(true);
      expect(provider.getBaseUrl()).toBe(PEER_B);
    });

    it("waits when every endpoint fails mid-batch, then finishes the remaining micro-batches and reports recovery", async () => {
      const down = { value: true };
      const failing = (): FakeLlamaServer => {
        const server: FakeLlamaServer = {
          health: true,
          embed: () => {
            if (!down.value) return undefined;
            server.health = false;
            return "refused";
          },
        };
        return server;
      };
      const serverA = failing();
      const serverB = failing();
      const cluster = fakeCluster({ [PEER_A]: serverA, [PEER_B]: serverB });
      const time = fakeTime();
      const provider = new LlamaServerEmbeddings(
        MODEL,
        undefined,
        { unavailableRetryMaxWaitMs: 60_000, unavailableRetryBaseDelayMs: 1_000 },
        `${PEER_A},${PEER_B}`,
        undefined,
        undefined,
        {
          fetch: cluster.fetch,
          ...time.deps,
          sleep: async (ms) => {
            await time.deps.sleep(ms);
            down.value = false;
            serverA.health = true;
            serverB.health = true;
          },
          log: () => {},
        },
      );
      const events: string[] = [];
      provider.onRecoveryWait = (event) => events.push(event.state);

      const results = await provider.embedBatch(texts(12));

      expect(results.map((r) => r.embedding[0])).toEqual(Array.from({ length: 12 }, (_, i) => i));
      expect(events).toEqual(["waiting", "recovered"]);
    });
  });

  describe("authorization", () => {
    it("sends Authorization: Bearer <key> to every endpoint when an API key is set", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy({ total_slots: 1 }), [PEER_B]: healthy() });
      const provider = makeProvider(cluster, { apiKey: "s3cret" });

      await provider.embedBatch(texts(4));

      expect(cluster.requests.length).toBeGreaterThan(0);
      for (const request of cluster.requests) expect(request.headers.Authorization).toBe("Bearer s3cret");
    });

    it("sends no Authorization header without an API key", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy({ total_slots: 1 }), [PEER_B]: healthy() });
      const provider = makeProvider(cluster);

      await provider.embedBatch(texts(4));

      for (const request of cluster.requests) expect(request.headers.Authorization).toBeUndefined();
    });

    it("propagates a 401 as a response error without failing the endpoint over", async () => {
      const cluster = fakeCluster({
        [PEER_A]: { health: true, embed: () => new Response('{"error":{"code":401}}', { status: 401 }) },
      });
      const provider = makeProvider(cluster, { peers: PEER_A });

      const error = await provider.embedBatch(["t1"]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerResponseError);
      expect((error as LlamaServerResponseError).responseStatus).toBe(401);
      expect(provider.getBaseUrl()).toBe(PEER_A);
    });
  });

  describe("endpoint failure", () => {
    it("re-splits a refused peer's texts onto the other peer in the same call and marks it unhealthy", async () => {
      const serverA: FakeLlamaServer = { health: true, embed: () => "refused" };
      const cluster = fakeCluster({ [PEER_A]: serverA, [PEER_B]: healthy() });
      const time = fakeTime();
      const provider = makeProvider(cluster, { time });

      const results = await provider.embedBatch(texts(6));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5]);
      expect(provider.getBaseUrl()).toBe(PEER_B);
      // The failback probe is armed once an endpoint fails.
      expect(time.intervalCount()).toBe(1);

      const before = cluster.embedCalls(PEER_A).length;
      await provider.embedBatch(texts(4));
      expect(cluster.embedCalls(PEER_A).length).toBe(before);
    });

    it("serves from the fallback tier when every peer is down, and returns to the peers once a probe succeeds", async () => {
      const serverA: FakeLlamaServer = { health: false };
      const serverB: FakeLlamaServer = { health: false };
      const cluster = fakeCluster({ [PEER_A]: serverA, [PEER_B]: serverB, [FALLBACK]: healthy() });
      const time = fakeTime();
      const provider = makeProvider(cluster, { fallbacks: FALLBACK, time });

      const results = await provider.embedBatch(texts(4));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3]);
      expect(cluster.embedCalls(FALLBACK).length).toBeGreaterThan(0);
      expect(provider.getBaseUrl()).toBe(FALLBACK);

      serverA.health = true;
      serverB.health = true;
      time.advance(60_000);
      await time.fireProbe();

      const fallbackCalls = cluster.embedCalls(FALLBACK).length;
      await provider.embedBatch(texts(4));
      expect(cluster.embedCalls(FALLBACK).length).toBe(fallbackCalls);
      expect(provider.getBaseUrl()).toBe(PEER_A);
    });

    it("throws the unavailable error once no endpoint answered for longer than the wait budget", async () => {
      const cluster = fakeCluster({ [PEER_A]: { health: false }, [PEER_B]: { health: false } });
      const time = fakeTime();
      const provider = makeProvider(cluster, {
        time,
        rateLimit: { unavailableRetryMaxWaitMs: 10_000, unavailableRetryBaseDelayMs: 1_000 },
      });

      const error = await provider.embedBatch(texts(2)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerUnavailableError);
      expect(isProviderRecoveryWaitSpent(error)).toBe(true);
      expect((error as LlamaServerUnavailableError).recoveryWaitMs).toBeGreaterThanOrEqual(10_000);
      expect((error as Error).message).toContain(PEER_A);
    });

    it("throws at once with no wait budget", async () => {
      const cluster = fakeCluster({ [PEER_A]: { health: false } });
      const provider = makeProvider(cluster, { peers: PEER_A });

      const error = await provider.embedBatch(texts(2)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerUnavailableError);
      expect((error as LlamaServerUnavailableError).recoveryWaitMs).toBe(0);
    });

    it("recovers inside the wait when a peer comes back", async () => {
      const serverA: FakeLlamaServer = { health: false };
      const cluster = fakeCluster({ [PEER_A]: serverA });
      const time = fakeTime();
      let sleeps = 0;
      const provider = new LlamaServerEmbeddings(
        MODEL,
        undefined,
        { unavailableRetryMaxWaitMs: 60_000, unavailableRetryBaseDelayMs: 1_000 },
        PEER_A,
        undefined,
        undefined,
        {
          fetch: cluster.fetch,
          ...time.deps,
          sleep: async (ms) => {
            sleeps += 1;
            await time.deps.sleep(ms);
            serverA.health = true;
          },
          log: () => {},
        },
      );

      const results = await provider.embedBatch(texts(2));

      expect(results).toHaveLength(2);
      expect(sleeps).toBeGreaterThan(0);
    });

    describe("per-call recovery budget", () => {
      it("throws after one direct reprobe and no sleep when the call allows no recovery wait", async () => {
        const cluster = fakeCluster({ [PEER_A]: { health: false }, [PEER_B]: { health: false } });
        const time = fakeTime();
        let sleeps = 0;
        const provider = makeProvider(cluster, {
          time: {
            ...time,
            deps: {
              ...time.deps,
              sleep: async (ms) => {
                sleeps += 1;
                await time.deps.sleep(ms);
              },
            },
          },
          rateLimit: { unavailableRetryMaxWaitMs: 240_000, unavailableRetryBaseDelayMs: 1_000 },
        });

        const error = await provider.embedBatch(texts(2), { maxRecoveryWaitMs: 0 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(LlamaServerUnavailableError);
        expect(isEmbeddingProviderUnavailable(error)).toBe(true);
        expect((error as LlamaServerUnavailableError).recoveryWaitMs).toBe(0);
        expect(sleeps).toBe(0);
        const healthProbes = cluster.requests.filter((r) => r.path === "/health");
        expect(healthProbes.map((r) => r.url).sort()).toEqual([PEER_A, PEER_B]);
      });

      it("embeds when an endpoint answers that one reprobe", async () => {
        const serverA: FakeLlamaServer = { health: true, embed: () => "refused" };
        const cluster = fakeCluster({ [PEER_A]: serverA });
        const time = fakeTime();
        const provider = makeProvider(cluster, {
          peers: PEER_A,
          time,
          rateLimit: { unavailableRetryMaxWaitMs: 240_000, failoverConsecutiveFailures: 1 },
        });
        // The first embed fails and marks the peer failed; the reprobe finds it back.
        let attempts = 0;
        serverA.embed = () => (attempts++ === 0 ? "refused" : undefined);

        const results = await provider.embed("t7", { maxRecoveryWaitMs: 0 });

        expect(results.embedding[0]).toBe(7);
      });

      it("waits no longer than the call allows when that is below the configured budget", async () => {
        const cluster = fakeCluster({ [PEER_A]: { health: false } });
        const time = fakeTime();
        const provider = makeProvider(cluster, {
          peers: PEER_A,
          time,
          rateLimit: { unavailableRetryMaxWaitMs: 240_000, unavailableRetryBaseDelayMs: 1_000 },
        });

        const error = await provider.embedBatch(texts(1), { maxRecoveryWaitMs: 5_000 }).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(LlamaServerUnavailableError);
        expect((error as LlamaServerUnavailableError).recoveryWaitMs).toBeGreaterThanOrEqual(5_000);
        expect((error as LlamaServerUnavailableError).recoveryWaitMs).toBeLessThan(10_000);
      });
    });

    it("counts a 5xx unrelated to size as a transient endpoint failure and moves the texts", async () => {
      const cluster = fakeCluster({
        [PEER_A]: { health: true, embed: () => new Response("model loading", { status: 503 }) },
        [PEER_B]: healthy(),
      });
      const provider = makeProvider(cluster);

      const results = await provider.embedBatch(texts(4));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3]);
    });
  });

  describe("size failure", () => {
    it("retries a batch the server fails on size in halves, notifies observers, and keeps the endpoint healthy", async () => {
      const cluster = fakeCluster({
        [PEER_A]: {
          health: true,
          embed: (input) =>
            input.length > 2
              ? new Response(
                  '{"error":{"code":500,"message":"input (1503 tokens) is too large to process. increase the physical batch size"}}',
                  { status: 500 },
                )
              : undefined,
        },
      });
      const provider = makeProvider(cluster, { peers: PEER_A });
      const events: unknown[] = [];
      const detach = provider.observeServerBatchFailures((event) => events.push(event));

      // One slot -> four micro-batches of 4 equal-length texts, each failing once on size.
      const input = Array.from({ length: 16 }, (_, i) => `t${String(i).padStart(2, "0")}`);
      const results = await provider.embedBatch(input);

      expect(results.map((r) => r.embedding[0])).toEqual(Array.from({ length: 16 }, (_, i) => i));
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event).toEqual({ failedSize: 4, retrySize: 2, endpointUrl: PEER_A });
      expect(provider.getBaseUrl()).toBe(PEER_A);

      const observed = events.length;
      detach();
      await provider.embedBatch(input);
      expect(events).toHaveLength(observed);
    });

    it("treats a socket reset on a multi-text request as a size failure", async () => {
      const cluster = fakeCluster({
        [PEER_A]: { health: true, embed: (input) => (input.length > 1 ? "reset" : undefined) },
      });
      const provider = makeProvider(cluster, { peers: PEER_A });
      const events: unknown[] = [];
      provider.observeServerBatchFailures((event) => events.push(event));

      // One slot -> four micro-batches of 2 texts, each reset once.
      const results = await provider.embedBatch(texts(8));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(event).toEqual({ failedSize: 2, retrySize: 1, endpointUrl: PEER_A });
    });

    it("reports a single text the server rejects on size as a context overflow", async () => {
      const cluster = fakeCluster({
        [PEER_A]: {
          health: true,
          embed: () => new Response('{"error":{"message":"input is too large to process"}}', { status: 500 }),
        },
      });
      const provider = makeProvider(cluster, { peers: PEER_A });

      const error = await provider.embedBatch(["t1"]).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerContextOverflowError);
      expect((error as LlamaServerContextOverflowError).code).toBe("INFRA_LLAMA_SERVER_CONTEXT_OVERFLOW");
      expect(provider.getBaseUrl()).toBe(PEER_A);
    });
  });

  describe("model check", () => {
    const OTHER_MODEL = { total_slots: 1, model_path: "/models/nomic-embed-text@latest-0123456789ab.gguf" };
    const SAME_MODEL = { total_slots: 1, model_path: "/models/jina-embeddings-v2-base-code@latest-33a8a1b6a1cb.gguf" };

    it("sends every text to the peer serving the configured model when the other serves another", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy(OTHER_MODEL), [PEER_B]: healthy(SAME_MODEL) });
      const log: string[] = [];
      const provider = makeProvider(cluster, { log });

      const first = await provider.embedBatch(texts(6));
      const second = await provider.embedBatch(texts(6));

      expect(first.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5]);
      expect(second.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3, 4, 5]);
      expect(cluster.embedCalls(PEER_A)).toHaveLength(0);
      expect(cluster.embedCalls(PEER_B).length).toBeGreaterThan(0);
      const warnings = log.filter((line) => line.includes("fetch-model"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(PEER_A);
      expect(warnings[0]).toContain(OTHER_MODEL.model_path);
      expect(warnings[0]).toContain(`EMBEDDING_MODEL=${MODEL}`);
      expect(warnings[0]).toContain("tea-rags llama-server command");
    });

    it("checks every endpoint, not only the one whose /props was read first", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy(SAME_MODEL), [PEER_B]: healthy(OTHER_MODEL) });
      const log: string[] = [];
      const provider = makeProvider(cluster, { log });

      await provider.embedBatch(texts(6));

      expect(cluster.embedCalls(PEER_B)).toHaveLength(0);
      expect(cluster.embedCalls(PEER_A).length).toBeGreaterThan(0);
      const warnings = log.filter((line) => line.includes("fetch-model"));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(PEER_B);
    });

    it("serves from the fallback when every peer serves another model", async () => {
      const cluster = fakeCluster({
        [PEER_A]: healthy(OTHER_MODEL),
        [PEER_B]: healthy(OTHER_MODEL),
        [FALLBACK]: healthy(SAME_MODEL),
      });
      const provider = makeProvider(cluster, { fallbacks: FALLBACK });

      const results = await provider.embedBatch(texts(4));

      expect(results.map((r) => r.embedding[0])).toEqual([0, 1, 2, 3]);
      expect(cluster.embedCalls(PEER_A)).toHaveLength(0);
      expect(cluster.embedCalls(PEER_B)).toHaveLength(0);
      expect(cluster.embedCalls(FALLBACK).length).toBeGreaterThan(0);
    });

    it("fails with a typed error naming each endpoint's model, without a recovery wait, when none serves it", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy(OTHER_MODEL), [PEER_B]: healthy(OTHER_MODEL) });
      const log: string[] = [];
      const time = fakeTime();
      const provider = makeProvider(cluster, { log, time, rateLimit: { unavailableRetryMaxWaitMs: 60_000 } });
      const waits: unknown[] = [];
      provider.onRecoveryWait = (event) => waits.push(event);
      const started = time.deps.now();

      const error = await provider.embedBatch(texts(4)).catch((e: unknown) => e);
      const again = await provider.embedBatch(texts(4)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerModelMismatchError);
      expect(again).toBeInstanceOf(LlamaServerModelMismatchError);
      const mismatch = error as LlamaServerModelMismatchError;
      expect(mismatch.code).toBe("INFRA_LLAMA_SERVER_MODEL_MISMATCH");
      expect(mismatch.message).toContain(`${PEER_A} serves ${OTHER_MODEL.model_path}`);
      expect(mismatch.message).toContain(`${PEER_B} serves ${OTHER_MODEL.model_path}`);
      expect(mismatch.message).toContain(MODEL);
      expect(cluster.embedCalls()).toHaveLength(0);
      expect(waits).toEqual([]);
      expect(time.deps.now()).toBe(started);
      expect(log.filter((line) => line.includes("fetch-model"))).toHaveLength(2);
    });

    it("waits for a down endpoint as an outage when the only other one serves another model", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy(OTHER_MODEL), [PEER_B]: { health: false } });
      const provider = makeProvider(cluster);

      const error = await provider.embedBatch(texts(2)).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LlamaServerUnavailableError);
      expect(cluster.embedCalls(PEER_A)).toHaveLength(0);
    });

    it("keeps sending to an endpoint whose model is a content-addressed blob", async () => {
      const blob = {
        model_path:
          "/Users/x/.ollama/models/blobs/sha256-33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986",
      };
      const cluster = fakeCluster({ [PEER_A]: healthy(blob), [PEER_B]: healthy(SAME_MODEL) });
      const provider = makeProvider(cluster);

      await provider.embedBatch(texts(8));

      expect(cluster.embedCalls(PEER_A).length).toBeGreaterThan(0);
      expect(cluster.embedCalls(PEER_B).length).toBeGreaterThan(0);
    });

    it("accepts a GGUF whose file name carries the model name", async () => {
      const props = { model_path: "/models/jina-embeddings-v2-base-code@latest-33a8a1b6a1cb.gguf" };
      const cluster = fakeCluster({ [PEER_A]: healthy(props) });
      const log: string[] = [];
      const provider = makeProvider(cluster, { peers: PEER_A, log });

      await provider.embedBatch(texts(2));

      expect(log.filter((line) => line.includes("fetch-model"))).toEqual([]);
    });

    it("accepts a content-addressed blob it cannot judge by name", async () => {
      const props = {
        model_path:
          "/Users/x/.ollama/models/blobs/sha256-33a8a1b6a1cbba662f292d32bb55f8d109c0e6cb02de2d243a1b70705ea20986",
      };
      const cluster = fakeCluster({ [PEER_A]: healthy(props) });
      const log: string[] = [];
      const provider = makeProvider(cluster, { peers: PEER_A, log });

      await provider.embedBatch(texts(2));

      expect(log.filter((line) => line.includes("fetch-model"))).toEqual([]);
    });
  });

  describe("model info", () => {
    it("reports the per-slot context and the registry width", async () => {
      const cluster = fakeCluster({
        [PEER_A]: healthy({ total_slots: 4, default_generation_settings: { n_ctx: 8192 } }),
      });
      const provider = makeProvider(cluster, { peers: PEER_A });

      expect(await provider.resolveModelInfo()).toEqual({ model: MODEL, contextLength: 8192, dimensions: 768 });
    });

    it("probes one embed for the width of a model the registry does not know", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy({ default_generation_settings: { n_ctx: 512 } }) });
      const provider = makeProvider(cluster, { peers: PEER_A, model: "acme/unknown-embedder" });

      const info = await provider.resolveModelInfo();

      expect(info).toEqual({ model: "acme/unknown-embedder", contextLength: 512, dimensions: 2 });
      expect(provider.getDimensions()).toBe(2);
    });

    it("keeps a pinned width", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy({ default_generation_settings: { n_ctx: 512 } }) });
      const provider = makeProvider(cluster, { peers: PEER_A, model: "acme/unknown-embedder", dimensions: 1024 });

      expect((await provider.resolveModelInfo())?.dimensions).toBe(1024);
      expect(cluster.embedCalls()).toHaveLength(0);
    });

    it("returns undefined when /props does not report a context", async () => {
      const cluster = fakeCluster({ [PEER_A]: healthy() });
      const provider = makeProvider(cluster, { peers: PEER_A });

      expect(await provider.resolveModelInfo()).toBeUndefined();
    });
  });

  describe("identity and health", () => {
    it("names itself llama-server and exposes the configured endpoint labels", () => {
      const cluster = fakeCluster({});
      const provider = makeProvider(cluster, { fallbacks: FALLBACK });

      expect(provider.getProviderName()).toBe("llama-server");
      expect(provider.getModel()).toBe(MODEL);
      expect(provider.getDimensions()).toBe(768);
      expect(provider.getBaseUrl()).toBe(PEER_A);
      expect(provider.getPrimaryBaseUrl()).toBe(`${PEER_A},${PEER_B}`);
      expect(provider.getFallbackBaseUrl()).toBe(FALLBACK);
    });

    it("reports no fallback when none is configured", async () => {
      const provider = makeProvider(fakeCluster({}));

      expect(provider.getFallbackBaseUrl()).toBeUndefined();
      expect(await provider.checkFallbackHealth()).toBeUndefined();
    });

    it("probes /health per tier", async () => {
      const cluster = fakeCluster({ [PEER_A]: { health: false }, [PEER_B]: { health: false }, [FALLBACK]: healthy() });
      const provider = makeProvider(cluster, { fallbacks: FALLBACK });

      expect(await provider.checkPrimaryHealth()).toBe(false);
      expect(await provider.checkFallbackHealth()).toBe(true);
      expect(await provider.checkHealth()).toBe(true);
      expect(cluster.requests.every((r) => r.path === "/health")).toBe(true);
    });

    it("checkHealth is false when no endpoint answers", async () => {
      const provider = makeProvider(fakeCluster({}), { fallbacks: FALLBACK });

      expect(await provider.checkHealth()).toBe(false);
    });
  });
});
