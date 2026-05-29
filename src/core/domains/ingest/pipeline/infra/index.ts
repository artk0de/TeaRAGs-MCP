/**
 * Public surface of the ingest pipeline's shared infra subdomain.
 *
 * Two distinct executors live here under deliberately distinct names:
 *
 *   - `WorkerPool` — in-process bounded-concurrency executor with retry/backoff
 *     for `Batch<T>` (consumed by the embedding pipeline).
 *   - `ThreadPool<Req, Res>` — generic `node:worker_threads` pool with
 *     round-robin + routingKey affinity (consumed by `ChunkerPool` and, in a
 *     future phase, by the enrichment executor).
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
export { ThreadPool } from "./thread-pool.js";
export { WorkerPool } from "./worker-pool.js";
