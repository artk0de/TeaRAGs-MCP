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
