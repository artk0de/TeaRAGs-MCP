/**
 * Chunked in-worker CPU profiler (bd tea-rags-mcp-6aytq).
 *
 * `--cpu-prof` (ENRICHMENT_WORKER_CPU_PROFILE_DIR) only writes its `.cpuprofile`
 * when the worker exits cleanly, so a run killed at a wall-clock budget loses
 * the whole profile — which is exactly the run we need to profile. This
 * mechanism rotates the profile on an interval instead, so a SIGKILL costs at
 * most the last chunk.
 *
 * Two things matter enough to pin: the env gate (unset ⇒ the worker allocates
 * nothing and touches no inspector session), and the interval being unref'd
 * (a profiler must never be the reason a worker thread stays alive). Inspector
 * mechanics are exercised through an injected session double — spawning a real
 * worker to prove a diagnostics-only rotation is not worth the wall clock.
 */

import { describe, expect, it, vi } from "vitest";

import {
  chunkedCpuProfilerConfigFromEnv,
  startChunkedCpuProfiler,
  type ChunkedCpuProfilerDeps,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/chunked-cpu-profiler.js";

/** Inspector session double: records posted methods, answers Profiler.stop. */
function fakeSession(): {
  session: ChunkedCpuProfilerDeps["createSession"] extends () => infer S ? S : never;
  posted: string[];
  connected: () => number;
  disconnected: () => number;
} {
  const posted: string[] = [];
  let connects = 0;
  let disconnects = 0;
  const session = {
    connect: () => {
      connects += 1;
    },
    disconnect: () => {
      disconnects += 1;
    },
    post: (method: string, callback: (err: Error | null, result?: unknown) => void) => {
      posted.push(method);
      callback(null, method === "Profiler.stop" ? { profile: { nodes: [], method } } : undefined);
    },
  };
  return {
    session: session as never,
    posted,
    connected: () => connects,
    disconnected: () => disconnects,
  };
}

function fakeDeps(overrides: Partial<ChunkedCpuProfilerDeps> = {}): {
  deps: ChunkedCpuProfilerDeps;
  written: { path: string; data: string }[];
  unref: ReturnType<typeof vi.fn>;
  fire: () => Promise<void>;
} {
  const written: { path: string; data: string }[] = [];
  const unref = vi.fn();
  let tick: (() => void) | undefined;
  const deps: ChunkedCpuProfilerDeps = {
    createSession: () => fakeSession().session,
    mkdir: async () => undefined,
    writeFile: async (path, data) => {
      written.push({ path, data });
    },
    setInterval: ((handler: () => void) => {
      tick = handler;
      return { unref } as unknown as NodeJS.Timeout;
    }) as unknown as ChunkedCpuProfilerDeps["setInterval"],
    clearInterval: () => undefined,
    threadId: 7,
    ...overrides,
  };
  return {
    deps,
    written,
    unref,
    fire: async () => {
      tick?.();
      // Drain the rotation's promise chain before assertions — a macrotask
      // boundary settles every pending microtask, however many awaits deep.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("chunkedCpuProfilerConfigFromEnv", () => {
  it("is disabled when the directory env var is unset", () => {
    expect(chunkedCpuProfilerConfigFromEnv({})).toBeUndefined();
  });

  it("is disabled when the directory env var is blank", () => {
    expect(chunkedCpuProfilerConfigFromEnv({ ENRICHMENT_WORKER_PROFILE_CHUNK_DIR: "   " })).toBeUndefined();
  });

  it("defaults the chunk interval to 60 seconds", () => {
    expect(chunkedCpuProfilerConfigFromEnv({ ENRICHMENT_WORKER_PROFILE_CHUNK_DIR: "/tmp/prof" })).toEqual({
      dir: "/tmp/prof",
      intervalMs: 60_000,
    });
  });

  it("accepts an explicit chunk interval in seconds", () => {
    expect(
      chunkedCpuProfilerConfigFromEnv({
        ENRICHMENT_WORKER_PROFILE_CHUNK_DIR: "/tmp/prof",
        ENRICHMENT_WORKER_PROFILE_CHUNK_SEC: "15",
      }),
    ).toEqual({ dir: "/tmp/prof", intervalMs: 15_000 });
  });

  it("falls back to the default on a non-positive or unparseable interval", () => {
    for (const raw of ["0", "-3", "abc", ""]) {
      expect(
        chunkedCpuProfilerConfigFromEnv({
          ENRICHMENT_WORKER_PROFILE_CHUNK_DIR: "/tmp/prof",
          ENRICHMENT_WORKER_PROFILE_CHUNK_SEC: raw,
        }),
      ).toEqual({ dir: "/tmp/prof", intervalMs: 60_000 });
    }
  });
});

describe("startChunkedCpuProfiler", () => {
  it("is fully inert without a config — no session, no timer", async () => {
    const { deps, unref } = fakeDeps();
    const createSession = vi.fn(deps.createSession);

    const handle = await startChunkedCpuProfiler(undefined, { ...deps, createSession });

    expect(handle).toBeUndefined();
    expect(createSession).not.toHaveBeenCalled();
    expect(unref).not.toHaveBeenCalled();
  });

  it("unrefs the rotation timer so it never holds the worker open", async () => {
    const { deps, unref } = fakeDeps();

    await startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, deps);

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("schedules the rotation at the configured interval", async () => {
    const setInterval = vi.fn(() => ({ unref: vi.fn() }) as unknown as NodeJS.Timeout);
    const { deps } = fakeDeps();

    await startChunkedCpuProfiler(
      { dir: "/tmp/prof", intervalMs: 15_000 },
      { ...deps, setInterval: setInterval as unknown as ChunkedCpuProfilerDeps["setInterval"] },
    );

    expect(setInterval).toHaveBeenCalledWith(expect.any(Function), 15_000);
  });

  it("starts the profiler on boot", async () => {
    const fake = fakeSession();
    const { deps } = fakeDeps({ createSession: () => fake.session });

    await startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, deps);

    expect(fake.connected()).toBe(1);
    expect(fake.posted).toEqual(["Profiler.enable", "Profiler.start"]);
  });

  it("writes a self-contained numbered chunk per rotation and restarts profiling", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({ createSession: () => fake.session });

    await startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, harness.deps);
    await harness.fire();
    await harness.fire();

    expect(harness.written.map((w) => w.path)).toEqual([
      "/tmp/prof/worker-7-0.cpuprofile",
      "/tmp/prof/worker-7-1.cpuprofile",
    ]);
    expect(JSON.parse(harness.written[0].data)).toEqual({ nodes: [], method: "Profiler.stop" });
    expect(fake.posted.filter((m) => m === "Profiler.start")).toHaveLength(3);
  });

  it("dumps a final chunk and disconnects on stop", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({ createSession: () => fake.session });

    const handle = await startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, harness.deps);
    await handle?.stop();

    expect(harness.written.map((w) => w.path)).toEqual(["/tmp/prof/worker-7-0.cpuprofile"]);
    expect(fake.disconnected()).toBe(1);
  });

  it("never lets a profiler failure escape into enrichment", async () => {
    const harness = fakeDeps({
      createSession: () => {
        throw new Error("inspector unavailable");
      },
    });

    await expect(
      startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, harness.deps),
    ).resolves.toBeUndefined();
  });

  it("swallows a write failure and keeps the rotation alive", async () => {
    const fake = fakeSession();
    const harness = fakeDeps({
      createSession: () => fake.session,
      writeFile: async () => {
        throw new Error("ENOSPC");
      },
    });

    const handle = await startChunkedCpuProfiler({ dir: "/tmp/prof", intervalMs: 5_000 }, harness.deps);
    await harness.fire();

    await expect(handle?.stop()).resolves.toBeUndefined();
  });
});
