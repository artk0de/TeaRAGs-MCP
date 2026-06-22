/**
 * Public surface of the ingest pipeline's shared infra subdomain.
 *
 * Two distinct executors live here under deliberately distinct names:
 *
 *   - `WorkerPool` — in-process bounded-concurrency executor with retry/backoff
 *     for `Batch<T>` (consumed by the embedding pipeline).
 *   - `WorkerDispatchPool<Req, Res>` — generic transport-backed worker pool with
 *     round-robin + routingKey affinity (consumed by `ChunkerPool` and the
 *     enrichment executor). Consumers inject a `WorkerTransport` (thread or
 *     process) — the pool's distribution mechanics are transport-agnostic.
 *
 * Cross-subdomain consumers SHOULD import through this barrel (per
 * `.claude/rules/barrel-files.md`). Existing deep imports from `runtime.ts` /
 * `debug-logger.ts` / `parallel.ts` are kept working — re-exported below — so
 * the barrel addition is non-breaking and incrementally adoptable.
 */

export { BatchAccumulator } from "./batch-accumulator.js";
export { pipelineLog } from "./debug-logger.js";
export { parallelLimit } from "./parallel.js";
export { isDebug, setDebug } from "./runtime.js";
export { WorkerDispatchPool } from "./worker-dispatch-pool.js";
export { WorkerPool } from "./worker-pool.js";
export { ThreadTransport } from "./thread-transport.js";
export type { WorkerTransport, WorkerHandle } from "./worker-transport.js";
