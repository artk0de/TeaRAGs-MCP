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
 * 6 GB is chosen against the working set of the configuration this project
 * actually ships, not against a round number. The original 2 GB predates the
 * whole-project `ts.Program` strategy and the raised `TSProgramCache` budgets
 * (e69abb6d); measured under those defaults on real taxdome — 10,912 TypeScript
 * files — the worker peaks at 5,375 MB heapUsed and 3,295 MB RSS. A 2 GB ceiling
 * is therefore no longer a safety net above a healthy run, it is BELOW one: on
 * any host that enforces it, a normal codegraph pass would be killed mid-run
 * with `ERR_WORKER_OUT_OF_MEMORY` every time. 6144 clears the measured peak with
 * ~14% headroom while still failing one thread long before a laptop swaps.
 *
 * The 2 GB default survived unnoticed because the dev machine sets a
 * process-wide `NODE_OPTIONS=--max_old_space_size=8192`, which OVERRIDES
 * per-worker `resourceLimits` — the ceiling was inert there, so the shipped
 * defaults were never tested against it. That silence is what
 * `../enrichment/infra/heap-ceiling-enforcement.ts` now reports at worker boot.
 *
 * Override with `ENRICHMENT_WORKER_MEMORY_LIMIT_MB`; an explicit `0` removes the
 * ceiling and restores the pre-guard behaviour. Sibling to the pool's other
 * tunable defaults, and named for the pool it bounds — the same way
 * `CHUNKER_WORKER_TIMEOUT_MS` is.
 */
export function defaultEnrichmentWorkerMemoryLimitMb(): number {
  const raw = process.env.ENRICHMENT_WORKER_MEMORY_LIMIT_MB;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 6144;
}

/**
 * Default V8 stack size (MB) for an enrichment worker thread.
 *
 * Node's worker_threads default (4 MB, matching V8's own `--stack-size`
 * default) is too small for `ts.createProgram`'s recursive module-resolution
 * walk on a large, barrel-connected TypeScript corpus (bd tea-rags-mcp-2j8s1
 * follow-up). Measured in isolation on a ~13,000-file synthetic corpus: at
 * the default stack, 270 of 300 `acquire()` calls overflowed and fell
 * through `TSProgramCache#build`'s null-return path — each failed attempt
 * still costing real CPU before failing, and none of them ever populated the
 * coverage cache 4m2vb built, so every subsequent file paid its own failed
 * attempt too (82.4s for 300 files). An 8 MB stack made every one of those
 * calls succeed on the first try — `programBuilds` dropped from 300 to 1,
 * wall time from 82.4s to 1.5s. 16 MB here is double that measured-sufficient
 * value, as headroom for taxdome's real (larger, not fully characterized)
 * barrel topology.
 *
 * Override with `ENRICHMENT_WORKER_STACK_SIZE_MB`; an explicit `0` opts back
 * into Node's own worker default (the pre-fix behaviour) — same "0 removes
 * the override" shape as `defaultEnrichmentWorkerMemoryLimitMb`.
 */
export function defaultEnrichmentWorkerStackSizeMb(): number {
  const raw = process.env.ENRICHMENT_WORKER_STACK_SIZE_MB;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 16;
}

/**
 * Diagnostic-only: directory to write a `.cpuprofile` for each enrichment
 * worker thread, or `undefined` (the default) to leave profiling off. Set via
 * `ENRICHMENT_WORKER_CPU_PROFILE_DIR` — an empty/unset value disables it, same
 * shape as the other pool tunables here. No default value, unlike the memory
 * ceiling: profiling has a real (if small) overhead and must stay opt-in.
 *
 * V8 flushes an `--cpu-prof` profile only on a CLEAN thread exit, so a run
 * killed at a wall-clock budget leaves nothing behind. The chunked in-worker
 * alternative — `ENRICHMENT_WORKER_PROFILE_CHUNK_DIR` /
 * `ENRICHMENT_WORKER_PROFILE_CHUNK_SEC`, see
 * `../enrichment/infra/chunked-cpu-profiler.ts` — rotates the profile on an
 * interval instead and survives a SIGKILL minus the last chunk. The two are
 * INDEPENDENT mechanisms over the same isolate: setting both is legal, and
 * neither disables the other.
 */
export function defaultEnrichmentWorkerCpuProfileDir(): string | undefined {
  const raw = process.env.ENRICHMENT_WORKER_CPU_PROFILE_DIR;
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}

/**
 * Diagnostic-only: directory V8 writes a heap snapshot into when this thread is
 * about to die of a heap OOM, or `undefined` (the default) to leave the hook
 * off. Set via `ENRICHMENT_WORKER_HEAPSNAPSHOT_DIR`.
 *
 * This covers the one failure the rest of the pool's instrumentation cannot
 * (bd tea-rags-mcp-6aytq). A V8 heap OOM does not raise: it kills the isolate,
 * so no `catch` in the enrichment code runs, the thread's buffered stdout is
 * dropped, and the pool learns only that the dispatch rejected with
 * `ERR_WORKER_OUT_OF_MEMORY`. What was actually retained at the moment of death
 * is unrecoverable afterwards — the forensics behind
 * `../../../../language/typescript/resolver/ts-program-heap-admission.ts` had to
 * be reconstructed by re-running the corpus under a scratch harness that
 * snapshotted before the kill.
 *
 * `--heapsnapshot-near-heap-limit=1` makes V8 write ONE snapshot as it
 * approaches the ceiling, and `--diagnostic-dir` says where. Off by default and
 * for the same reason as the CPU profile beside it, only more so: writing a
 * multi-gigabyte snapshot takes minutes and is the last thing a healthy run
 * should risk.
 */
export function defaultEnrichmentWorkerHeapSnapshotDir(): string | undefined {
  const raw = process.env.ENRICHMENT_WORKER_HEAPSNAPSHOT_DIR;
  return raw !== undefined && raw.trim() !== "" ? raw : undefined;
}
