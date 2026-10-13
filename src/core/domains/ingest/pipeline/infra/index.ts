/**
 * Public surface of the ingest pipeline's shared infra subdomain.
 *
 * What lives here is the in-process batching side: the work-item vocabulary
 * (`ChunkItem`, `Batch<T>`, …), `BatchAccumulator`, and `WorkerPool` — the
 * in-process bounded-concurrency executor with retry/backoff for `Batch<T>`
 * (consumed by the embedding pipeline).
 *
 * Two sub-components carry their own facades and are NOT re-exported here
 * beyond `pipelineLog`:
 *
 *   - `worker-dispatch/index.js` — the worker thread/process dispatch runtime
 *     (`WorkerDispatchPool<Req, Res>`, the transports, the worker-side runtime,
 *     pool sizing defaults), consumed by `ChunkerPool` and the enrichment
 *     executor. Despite the similar name it shares nothing with `WorkerPool`.
 *   - `debug-log/index.js` — the pipeline debug logger.
 *
 * Cross-subdomain consumers SHOULD import through this barrel (per
 * `.claude/rules/barrel-files.md`). Existing deep imports from `parallel.ts`
 * are kept working — re-exported below — so the barrel addition is
 * non-breaking and incrementally adoptable.
 */

export { BatchAccumulator } from "./batch-accumulator.js";
export type {
  Batch,
  BatchAccumulatorConfig,
  BatchCompletionCallback,
  BatchFlushTrigger,
  BatchHandler,
  BatchResult,
  BackpressureCallback,
  ChunkItem,
  DeleteItem,
  OperationType,
  UpsertItem,
  WorkerPoolConfig,
  WorkItem,
} from "./types.js";
export { pipelineLog } from "./debug-log/index.js";
export { parallelLimit } from "./parallel.js";
export { isDebug, setDebug } from "../../../../primitives/diagnostics/index.js";
export { WorkerPool } from "./worker-pool.js";
