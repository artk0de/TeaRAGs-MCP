/**
 * Kill-surviving SAMPLING heap profile of an enrichment worker thread
 * (bd tea-rags-mcp-vtuu4).
 *
 * The failure this exists for is a V8 heap OOM in the worker, and that failure
 * defeats every other heap instrument we have:
 *
 * - An OOM does not raise — it kills the isolate. No `catch`, no `finally`, no
 *   shutdown hook in the enrichment code runs.
 * - `--heap-prof` writes its `.heapprofile` only on a CLEAN thread exit, so the
 *   run that died of the heap is exactly the run that produces nothing.
 * - `ENRICHMENT_WORKER_HEAPSNAPSHOT_DIR` (`--heapsnapshot-near-heap-limit`, see
 *   `../../infra/pool-defaults.ts`) writes ONE full, non-sampling snapshot at the
 *   ceiling: multi-gigabyte, minutes to write, frequently cut short by the very
 *   kill it anticipates, and with no view of how the heap got there.
 *
 * This mechanism opens an in-worker `node:inspector` session, starts the
 * sampling heap profiler once, and on an interval dumps
 * `HeapProfiler.getSamplingProfile`. Unlike the CPU profiler beside it
 * (`./chunked-cpu-profiler.ts`) it never stops/restarts: the sampling profile
 * is CUMULATIVE over objects still LIVE, so each dump is the full picture of
 * what is retained at that instant, and the last dump before the kill is the
 * answer to "what filled the heap". A `.heapstats.json` next to each profile
 * records `v8.getHeapStatistics()` and a timestamp, so the dumps can be placed
 * on the approach to `heap_size_limit`. Since each dump supersedes the ones
 * before it and profiles can be large, only the last {@link RETAINED_DUMPS}
 * pairs are kept on disk.
 *
 * Same placement rationale as the CPU profiler: `inspector.Session` is
 * per-ISOLATE, so it must live in the worker entry, not the pool.
 *
 * Every code path here is wrapped: profiling must never be the reason an
 * enrichment run fails.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import { threadId } from "node:worker_threads";

/** Dump cadence when the caller does not name one. */
const DEFAULT_INTERVAL_SEC = 30;
/** V8's default mean sampling interval (bytes between samples). */
const DEFAULT_SAMPLING_BYTES = 262_144;
/** Dump pairs kept on disk; older ones are superseded by the cumulative profile. */
const RETAINED_DUMPS = 3;

export interface ChunkedHeapProfilerConfig {
  /** Directory the `.heapprofile` / `.heapstats.json` pairs are written to. */
  dir: string;
  /** Milliseconds between dumps. */
  intervalMs: number;
  /** Mean bytes allocated between samples (`HeapProfiler.startSampling`). */
  samplingIntervalBytes: number;
}

type InspectorCallback = (err: Error | null, result?: unknown) => void;

/**
 * Minimal inspector-session surface this module uses. Distinct from the CPU
 * profiler's `InspectorSessionLike` because `startSampling` needs the
 * params-carrying `post` overload.
 */
export interface HeapInspectorSessionLike {
  connect: () => void;
  disconnect: () => void;
  post: {
    (method: string, callback: InspectorCallback): void;
    (method: string, params: object, callback: InspectorCallback): void;
  };
}

/** The `v8.getHeapStatistics()` fields recorded next to each dump. */
export interface HeapStatsSample {
  used_heap_size: number;
  total_heap_size: number;
  heap_size_limit: number;
}

export interface ChunkedHeapProfilerDeps {
  createSession: () => HeapInspectorSessionLike;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  rm: (path: string) => Promise<void>;
  setInterval: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
  getHeapStatistics: () => HeapStatsSample;
  now: () => number;
  /** Distinguishes dumps when several workers profile into one directory. */
  threadId: number;
}

export interface ChunkedHeapProfilerHandle {
  /** Final dump + stopSampling + disconnect. Safe to call twice; never throws. */
  stop: () => Promise<void>;
}

function positiveIntOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Read the profiler's configuration off the environment, or `undefined` when it
 * is off — the default. Blank means unset; an unparseable or non-positive
 * interval / sampling size falls back to its default rather than disabling the
 * profiler, because the directory being set states the operator's intent.
 */
export function chunkedHeapProfilerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChunkedHeapProfilerConfig | undefined {
  const dir = env.ENRICHMENT_WORKER_HEAP_PROFILE_DIR;
  if (dir === undefined || dir.trim() === "") return undefined;
  return {
    dir: dir.trim(),
    intervalMs: positiveIntOr(env.ENRICHMENT_WORKER_HEAP_PROFILE_SEC, DEFAULT_INTERVAL_SEC) * 1000,
    samplingIntervalBytes: positiveIntOr(env.ENRICHMENT_WORKER_HEAP_PROFILE_SAMPLING_BYTES, DEFAULT_SAMPLING_BYTES),
  };
}

function defaultDeps(): ChunkedHeapProfilerDeps {
  return {
    createSession: () => new Session(),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path, data) => {
      await writeFile(path, data, "utf8");
    },
    rm: async (path) => {
      await rm(path, { force: true });
    },
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (timer) => {
      clearInterval(timer);
    },
    getHeapStatistics,
    now: () => Date.now(),
    threadId,
  };
}

async function post<T>(session: HeapInspectorSessionLike, method: string, params?: object): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const callback: InspectorCallback = (err, result) => {
      if (err) reject(err);
      else resolve(result as T);
    };
    if (params === undefined) session.post(method, callback);
    else session.post(method, params, callback);
  });
}

/**
 * Start sampling heap profiling for this worker. Returns `undefined` when
 * profiling is off (no config) OR when starting it failed — enrichment carries
 * on regardless.
 */
export async function startChunkedHeapProfiler(
  config: ChunkedHeapProfilerConfig | undefined,
  deps: ChunkedHeapProfilerDeps = defaultDeps(),
): Promise<ChunkedHeapProfilerHandle | undefined> {
  if (!config) return undefined;

  let session: HeapInspectorSessionLike;
  try {
    await deps.mkdir(config.dir);
    session = deps.createSession();
    session.connect();
    await post(session, "HeapProfiler.enable");
    await post(session, "HeapProfiler.startSampling", { samplingInterval: config.samplingIntervalBytes });
  } catch {
    return undefined;
  }

  let sequence = 0;
  let stopped = false;
  // Dumps are chained: a tick landing while the previous (possibly large)
  // write is in flight queues behind it instead of interleaving files.
  let chain: Promise<void> = Promise.resolve();

  const pathsFor = (seq: number): [string, string] => {
    const base = join(config.dir, `worker-${deps.threadId}-${seq}`);
    return [`${base}.heapprofile`, `${base}.heapstats.json`];
  };

  const dump = async (): Promise<void> => {
    const seq = sequence;
    sequence += 1;
    const [profilePath, statsPath] = pathsFor(seq);
    try {
      const result = await post<{ profile?: unknown }>(session, "HeapProfiler.getSamplingProfile");
      await deps.writeFile(profilePath, JSON.stringify(result?.profile ?? {}));
    } catch {
      // A failed dump is a lost dump; the next tick produces a fresh one.
    }
    try {
      const stats = deps.getHeapStatistics();
      await deps.writeFile(
        statsPath,
        JSON.stringify({
          used_heap_size: stats.used_heap_size,
          total_heap_size: stats.total_heap_size,
          heap_size_limit: stats.heap_size_limit,
          timestamp: deps.now(),
        }),
      );
    } catch {
      // Stats are a companion to the profile, never a reason to stop dumping.
    }
    const expired = seq - RETAINED_DUMPS;
    if (expired < 0) return;
    for (const path of pathsFor(expired)) {
      try {
        await deps.rm(path);
      } catch {
        // A leftover old dump costs disk, not correctness.
      }
    }
  };

  const enqueue = async (): Promise<void> => {
    chain = chain.then(dump);
    return chain;
  };

  const timer = deps.setInterval(() => {
    if (stopped) return;
    void enqueue();
  }, config.intervalMs);
  // MUST be unref'd: a diagnostics timer holding the event loop open would keep
  // the worker thread from ever exiting.
  timer.unref?.();

  return {
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        deps.clearInterval(timer);
        await enqueue();
      } catch {
        // Fall through to the teardown below regardless.
      }
      try {
        await post(session, "HeapProfiler.stopSampling");
      } catch {
        // Sampling dies with the session anyway.
      }
      try {
        session.disconnect();
      } catch {
        // Shutdown-time diagnostics failure — nothing left to salvage.
      }
    },
  };
}
