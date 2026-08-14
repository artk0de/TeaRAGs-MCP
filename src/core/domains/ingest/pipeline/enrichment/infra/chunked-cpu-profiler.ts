/**
 * Kill-surviving CPU profile of an enrichment worker thread
 * (bd tea-rags-mcp-6aytq).
 *
 * `ENRICHMENT_WORKER_CPU_PROFILE_DIR` (see `../../infra/pool-defaults.ts`)
 * passes `--cpu-prof` on the worker's `execArgv`, and V8 writes that
 * `.cpuprofile` only when the thread exits CLEANLY. A codegraph force-resolve
 * that is killed at a wall-clock budget — the exact run worth profiling —
 * therefore produces nothing at all.
 *
 * This is the other mechanism: an in-worker `node:inspector` session that stops,
 * writes and restarts the profiler on an interval, so each file on disk is a
 * self-contained valid `.cpuprofile` and a SIGKILL costs at most the last
 * chunk. The two are INDEPENDENT and may both be set; they profile the same
 * isolate through different plumbing and neither disables the other.
 *
 * Why it lives in the worker entry and not the pool: `inspector.Session` is
 * per-ISOLATE. The enrichment pool uses `ThreadTransport`, so the parent and
 * the worker share a process but not an isolate — a session opened in the
 * parent profiles the parent, which is idle while the worker does the work.
 *
 * Every code path here is wrapped: profiling must never be the reason an
 * enrichment run fails.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { join } from "node:path";
import { threadId } from "node:worker_threads";

/** Chunk rotation cadence when the caller does not name one. */
const DEFAULT_CHUNK_SEC = 60;

export interface ChunkedCpuProfilerConfig {
  /** Directory the `.cpuprofile` chunks are written to. */
  dir: string;
  /** Milliseconds between rotations. */
  intervalMs: number;
}

/** Minimal surface this module uses from an inspector session. */
export interface InspectorSessionLike {
  connect: () => void;
  disconnect: () => void;
  post: (method: string, callback: (err: Error | null, result?: unknown) => void) => void;
}

export interface ChunkedCpuProfilerDeps {
  createSession: () => InspectorSessionLike;
  mkdir: (path: string) => Promise<void>;
  writeFile: (path: string, data: string) => Promise<void>;
  setInterval: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearInterval: (timer: NodeJS.Timeout) => void;
  /** Distinguishes chunks when several workers profile into one directory. */
  threadId: number;
}

export interface ChunkedCpuProfilerHandle {
  /** Final rotation + disconnect. Safe to call twice; never throws. */
  stop: () => Promise<void>;
}

/**
 * Read the profiler's configuration off the environment, or `undefined` when it
 * is off — the default. Same "blank means unset" shape as the other worker
 * knobs in `pool-defaults.ts`; an unparseable or non-positive chunk length
 * falls back to the default rather than disabling the profiler, because the
 * operator's intent (the directory being set) is unambiguous.
 */
export function chunkedCpuProfilerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ChunkedCpuProfilerConfig | undefined {
  const dir = env.ENRICHMENT_WORKER_PROFILE_CHUNK_DIR;
  if (dir === undefined || dir.trim() === "") return undefined;
  const rawSec = env.ENRICHMENT_WORKER_PROFILE_CHUNK_SEC;
  let seconds = DEFAULT_CHUNK_SEC;
  if (rawSec !== undefined && rawSec.trim() !== "") {
    const parsed = Number.parseInt(rawSec, 10);
    if (Number.isFinite(parsed) && parsed > 0) seconds = parsed;
  }
  return { dir: dir.trim(), intervalMs: seconds * 1000 };
}

function defaultDeps(): ChunkedCpuProfilerDeps {
  return {
    createSession: () => new Session() as unknown as InspectorSessionLike,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    writeFile: async (path, data) => {
      await writeFile(path, data, "utf8");
    },
    setInterval: (handler, ms) => setInterval(handler, ms),
    clearInterval: (timer) => {
      clearInterval(timer);
    },
    threadId,
  };
}

async function post<T>(session: InspectorSessionLike, method: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    session.post(method, (err, result) => {
      if (err) reject(err);
      else resolve(result as T);
    });
  });
}

/**
 * Start chunked profiling for this worker. Returns `undefined` when profiling
 * is off (no config) OR when starting it failed — the caller has nothing to do
 * differently in either case, and enrichment carries on regardless.
 */
export async function startChunkedCpuProfiler(
  config: ChunkedCpuProfilerConfig | undefined,
  deps: ChunkedCpuProfilerDeps = defaultDeps(),
): Promise<ChunkedCpuProfilerHandle | undefined> {
  if (!config) return undefined;

  let session: InspectorSessionLike;
  try {
    await deps.mkdir(config.dir);
    session = deps.createSession();
    session.connect();
    await post(session, "Profiler.enable");
    await post(session, "Profiler.start");
  } catch {
    return undefined;
  }

  let sequence = 0;
  let stopped = false;
  // Rotations are chained rather than fired concurrently: a tick that lands
  // while the previous stop/write is still in flight would otherwise post a
  // second `Profiler.stop` against a profiler that is no longer running.
  let chain: Promise<void> = Promise.resolve();

  const rotate = async (restart: boolean): Promise<void> => {
    try {
      const result = await post<{ profile?: unknown }>(session, "Profiler.stop");
      const path = join(config.dir, `worker-${deps.threadId}-${sequence}.cpuprofile`);
      sequence += 1;
      await deps.writeFile(path, JSON.stringify(result?.profile ?? {}));
    } catch {
      // A failed chunk is a lost chunk, nothing more. Fall through to the
      // restart so the next interval still produces one.
    }
    if (!restart) return;
    try {
      await post(session, "Profiler.start");
    } catch {
      // Profiling is over for this worker; the chunks already on disk stand.
    }
  };

  const enqueue = async (restart: boolean): Promise<void> => {
    chain = chain.then(async () => rotate(restart));
    return chain;
  };

  const timer = deps.setInterval(() => {
    if (stopped) return;
    void enqueue(true);
  }, config.intervalMs);
  // MUST be unref'd: a diagnostics timer that keeps the event loop alive would
  // stop the worker thread from ever exiting, turning an opt-in profile into a
  // hung enrichment run.
  timer.unref?.();

  return {
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      try {
        deps.clearInterval(timer);
        await enqueue(false);
        session.disconnect();
      } catch {
        // Shutdown-time diagnostics failure — nothing left to salvage.
      }
    },
  };
}
