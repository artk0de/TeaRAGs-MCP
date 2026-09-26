/**
 * Chunked in-worker sampling heap profiler (bd tea-rags-mcp-vtuu4).
 *
 * A V8 heap OOM kills the isolate outright: no `catch` runs and `--heap-prof`
 * flushes only on a clean exit, so the run worth profiling leaves nothing. This
 * mechanism dumps the CUMULATIVE sampling profile on an interval, so the last
 * dump before the kill is on disk. Inspector mechanics run through an injected
 * session double, same as the CPU profiler beside it.
 */

import { describe, expect, it, vi } from "vitest";

import {
  chunkedHeapProfilerConfigFromEnv,
  startChunkedHeapProfiler,
  type ChunkedHeapProfilerDeps,
  type HeapInspectorSessionLike,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/chunked-heap-profiler.js";

interface PostedCall {
  method: string;
  params?: unknown;
}

function fakeSession(): {
  session: HeapInspectorSessionLike;
  posted: PostedCall[];
  connected: () => number;
  disconnected: () => number;
} {
  const posted: PostedCall[] = [];
  let connects = 0;
  let disconnects = 0;
  let samples = 0;
  const post = ((
    method: string,
    paramsOrCallback: unknown,
    maybeCallback?: (err: Error | null, result?: unknown) => void,
  ) => {
    const callback = (typeof paramsOrCallback === "function" ? paramsOrCallback : maybeCallback) as (
      err: Error | null,
      result?: unknown,
    ) => void;
    const params = typeof paramsOrCallback === "function" ? undefined : paramsOrCallback;
    posted.push(params === undefined ? { method } : { method, params });
    if (method === "HeapProfiler.getSamplingProfile") {
      samples += 1;
      callback(null, { profile: { head: {}, samples: [], dump: samples } });
      return;
    }
    callback(null, undefined);
  }) as HeapInspectorSessionLike["post"];
  const session: HeapInspectorSessionLike = {
    connect: () => {
      connects += 1;
    },
    disconnect: () => {
      disconnects += 1;
    },
    post,
  };
  return { session, posted, connected: () => connects, disconnected: () => disconnects };
}

function fakeDeps(overrides: Partial<ChunkedHeapProfilerDeps> = {}): {
  deps: ChunkedHeapProfilerDeps;
  written: { path: string; data: string }[];
  removed: string[];
  unref: ReturnType<typeof vi.fn>;
  fire: () => Promise<void>;
} {
  const written: { path: string; data: string }[] = [];
  const removed: string[] = [];
  const unref = vi.fn();
  let tick: (() => void) | undefined;
  const deps: ChunkedHeapProfilerDeps = {
    createSession: () => fakeSession().session,
    mkdir: async () => undefined,
    writeFile: async (path, data) => {
      written.push({ path, data });
    },
    rm: async (path) => {
      removed.push(path);
    },
    setInterval: (handler: () => void) => {
      tick = handler;
      return { unref } as unknown as NodeJS.Timeout;
    },
    clearInterval: () => undefined,
    getHeapStatistics: () => ({ used_heap_size: 100, total_heap_size: 200, heap_size_limit: 400 }),
    now: () => 1_700_000_000_000,
    threadId: 7,
    ...overrides,
  };
  return {
    deps,
    written,
    removed,
    unref,
    fire: async () => {
      tick?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const CONFIG = { dir: "/tmp/heap", intervalMs: 5_000, samplingIntervalBytes: 4096 };

describe("chunkedHeapProfilerConfigFromEnv", () => {
  it("is disabled when the directory env var is unset", () => {
    expect(chunkedHeapProfilerConfigFromEnv({})).toBeUndefined();
  });

  it("is disabled when the directory env var is blank", () => {
    expect(chunkedHeapProfilerConfigFromEnv({ ENRICHMENT_WORKER_HEAP_PROFILE_DIR: "  " })).toBeUndefined();
  });

  it("defaults to a 30 s interval and 256 KiB sampling", () => {
    expect(chunkedHeapProfilerConfigFromEnv({ ENRICHMENT_WORKER_HEAP_PROFILE_DIR: " /tmp/heap " })).toEqual({
      dir: "/tmp/heap",
      intervalMs: 30_000,
      samplingIntervalBytes: 262_144,
    });
  });

  it("accepts explicit interval and sampling bytes", () => {
    expect(
      chunkedHeapProfilerConfigFromEnv({
        ENRICHMENT_WORKER_HEAP_PROFILE_DIR: "/tmp/heap",
        ENRICHMENT_WORKER_HEAP_PROFILE_SEC: "10",
        ENRICHMENT_WORKER_HEAP_PROFILE_SAMPLING_BYTES: "65536",
      }),
    ).toEqual({ dir: "/tmp/heap", intervalMs: 10_000, samplingIntervalBytes: 65_536 });
  });

  it("falls back to defaults on non-positive or unparseable values", () => {
    for (const raw of ["0", "-3", "abc", ""]) {
      expect(
        chunkedHeapProfilerConfigFromEnv({
          ENRICHMENT_WORKER_HEAP_PROFILE_DIR: "/tmp/heap",
          ENRICHMENT_WORKER_HEAP_PROFILE_SEC: raw,
          ENRICHMENT_WORKER_HEAP_PROFILE_SAMPLING_BYTES: raw,
        }),
      ).toEqual({ dir: "/tmp/heap", intervalMs: 30_000, samplingIntervalBytes: 262_144 });
    }
  });
});

describe("startChunkedHeapProfiler", () => {
  it("is fully inert without a config — no session, no timer", async () => {
    const { deps, unref } = fakeDeps();
    const createSession = vi.fn(deps.createSession);

    const handle = await startChunkedHeapProfiler(undefined, { ...deps, createSession });

    expect(handle).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(unref).not.toHaveBeenCalled();
  });

  it("enables the heap profiler and starts sampling at the configured interval", async () => {
    const fake = fakeSession();
    const { deps } = fakeDeps({ createSession: () => fake.session });

    await startChunkedHeapProfiler(CONFIG, deps);

    expect(fake.connected()).toBe(1);
    expect(fake.posted).toEqual([
      { method: "HeapProfiler.enable" },
      { method: "HeapProfiler.startSampling", params: { samplingInterval: 4096 } },
    ]);
  });

  it("schedules dumps at the configured interval and unrefs the timer", async () => {
    const unref = vi.fn();
    const setInterval = vi.fn(() => ({ unref }) as unknown as NodeJS.Timeout);
    const { deps } = fakeDeps();

    await startChunkedHeapProfiler(CONFIG, {
      ...deps,
      setInterval: setInterval as unknown as ChunkedHeapProfilerDeps["setInterval"],
    });

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 5_000);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("writes a numbered profile + heap-stats pair per tick without restarting sampling", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({ createSession: () => fake.session });

    await startChunkedHeapProfiler(CONFIG, harness.deps);
    await harness.fire();
    await harness.fire();

    expect(harness.written.map((w) => w.path)).toEqual([
      "/tmp/heap/worker-7-0.heapprofile",
      "/tmp/heap/worker-7-0.heapstats.json",
      "/tmp/heap/worker-7-1.heapprofile",
      "/tmp/heap/worker-7-1.heapstats.json",
    ]);
    expect(JSON.parse(harness.written[0].data)).toEqual({ head: {}, samples: [], dump: 1 });
    expect(JSON.parse(harness.written[1].data)).toEqual({
      used_heap_size: 100,
      total_heap_size: 200,
      heap_size_limit: 400,
      timestamp: 1_700_000_000_000,
    });
    const methods = fake.posted.map((p) => p.method);
    expect(methods.filter((m) => m === "HeapProfiler.startSampling")).toHaveLength(1);
    expect(methods).not.toContain("HeapProfiler.stopSampling");
  });

  it("keeps only the last three dump pairs on disk", async () => {
    const harness = fakeDeps();

    await startChunkedHeapProfiler(CONFIG, harness.deps);
    for (let i = 0; i < 5; i += 1) await harness.fire();

    expect(harness.removed).toEqual([
      "/tmp/heap/worker-7-0.heapprofile",
      "/tmp/heap/worker-7-0.heapstats.json",
      "/tmp/heap/worker-7-1.heapprofile",
      "/tmp/heap/worker-7-1.heapstats.json",
    ]);
  });

  it("dumps a final pair, stops sampling and disconnects on stop — idempotently", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({ createSession: () => fake.session });

    const handle = await startChunkedHeapProfiler(CONFIG, harness.deps);
    await handle?.stop();
    await handle?.stop();

    expect(harness.written.map((w) => w.path)).toEqual([
      "/tmp/heap/worker-7-0.heapprofile",
      "/tmp/heap/worker-7-0.heapstats.json",
    ]);
    const methods = fake.posted.map((p) => p.method);
    expect(methods.slice(-2)).toEqual(["HeapProfiler.getSamplingProfile", "HeapProfiler.stopSampling"]);
    expect(methods.filter((m) => m === "HeapProfiler.stopSampling")).toHaveLength(1);
    expect(fake.disconnected()).toBe(1);
  });

  it("resolves undefined when starting the session fails", async () => {
    const harness = fakeDeps({
      createSession: () => {
        throw new Error("inspector unavailable");
      },
    });

    await expect(startChunkedHeapProfiler(CONFIG, harness.deps)).resolves.toBeUndefined();
  });

  it("swallows write, rm and stats failures and keeps dumping", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({
      createSession: () => fake.session,
      writeFile: async () => {
        throw new Error("ENOSPC");
      },
      rm: async () => {
        throw new Error("EACCES");
      },
      getHeapStatistics: () => {
        throw new Error("boom");
      },
    });

    const handle = await startChunkedHeapProfiler(CONFIG, harness.deps);
    for (let i = 0; i < 5; i += 1) await harness.fire();

    await expect(handle?.stop()).resolves.toBeUndefined();
    expect(fake.posted.filter((p) => p.method === "HeapProfiler.getSamplingProfile")).toHaveLength(6);
  });

  it("never throws from stop even when the inspector fails", async () => {
    const harness = fakeDeps();
    const { session } = fakeSession();
    const handle = await startChunkedHeapProfiler(CONFIG, { ...harness.deps, createSession: () => session });
    session.post = (method: string, ...rest: unknown[]) => {
      const callback = rest[rest.length - 1] as (err: Error | null) => void;
      callback(new Error(`${method} failed`));
    };
    session.disconnect = () => {
      throw new Error("disconnect failed");
    };

    await expect(handle?.stop()).resolves.toBeUndefined();
  });
});
