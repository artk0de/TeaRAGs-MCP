import os from "node:os";

/** Parallel chunker default now that workers are process-isolated (cap 4 to bound memory). */
export function defaultChunkerPoolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}

/**
 * Default per-dispatch worker liveness timeout (ms) for `WorkerDispatchPool`.
 *
 * Generous on purpose: a single legitimately-large/minified file can take tens
 * of seconds to parse (minified d3.js ~51s, bead 9oq5e), so the bound must clear
 * the worst legit parse with headroom while still catching a silent worker hang
 * (tree-sitter NAPI native crash/deadlock under load, yl9tv). Overridable via
 * the `CHUNKER_WORKER_TIMEOUT_MS` env var; an explicit `0` (or a negative /
 * unparseable value) disables the bound and restores legacy unbounded behavior.
 * Read here — sibling to the pool — mirroring how `defaultChunkerPoolSize` owns
 * the pool's other tunable default.
 */
export function defaultWorkerDispatchTimeoutMs(): number {
  const raw = process.env.CHUNKER_WORKER_TIMEOUT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 120_000;
}

/**
 * Default old-generation heap ceiling (MB) for an enrichment worker thread.
 *
 * The enrichment pool has no liveness timeout — a codegraph finalize
 * legitimately runs for minutes (`executor/worker-pool.ts`) — so an unbounded
 * worker has nothing at all standing between it and the machine's memory. One
 * did exactly that: a codegraph recompute over a large TypeScript repository
 * reached 2.6 GB RSS and was still climbing 46 minutes in, driving host swap to
 * 92% and free RAM to ~50 MB before it was killed by hand.
 *
 * A ceiling converts that into `ERR_WORKER_OUT_OF_MEMORY` on one thread: the
 * dispatch rejects, `WorkerDispatchPool` respawns the slot, and the rest of the
 * machine never notices. Failing one worker fast beats degrading everything
 * slowly.
 *
 * 2 GB is deliberately well above any healthy run and well below the point
 * where a laptop starts swapping. Override with
 * `ENRICHMENT_WORKER_MEMORY_LIMIT_MB`; an explicit `0` removes the ceiling and
 * restores the pre-guard behaviour. Sibling to the pool's other tunable
 * defaults, and named for the pool it bounds — the same way
 * `CHUNKER_WORKER_TIMEOUT_MS` is.
 */
export function defaultEnrichmentWorkerMemoryLimitMb(): number {
  const raw = process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 2048;
}

/**
 * Diagnostic-only: directory to write a `.cpuprofile` for each enrichment
 * worker thread, or `undefined` (the default) to leave profiling off. Set via
 * `ENRICHMENT_WORKER_CPU_PROFILE_DIR` — an empty/unset value disables it, same
 * shape as the other pool tunables here. No default value, unlike the memory
 * ceiling: profiling has a real (if small) overhead and must stay opt-in.
 */
export function defaultEnrichmentWorkerCpuProfileDir(): string | undefined {
  const raw = process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR;
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}
