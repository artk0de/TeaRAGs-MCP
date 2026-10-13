/**
 * Public surface of the worker dispatch runtime: the substrate that runs
 * pipeline work in worker threads or child processes.
 *
 * Parent side: `WorkerDispatchPool<Req, Res>` distributes requests round-robin
 * (or by routingKey affinity) over handles a `WorkerTransport` spawns —
 * `ThreadTransport` for `worker_threads`, `ProcessTransport` for forked
 * processes. Worker side: `createWorkerRuntime` answers that protocol inside the
 * spawned entry, and `applyWorkerDebug` replays the parent's debug flag there.
 * The env-driven sizing defaults for both pools live here too, because the
 * dispatch timeout the pool enforces is one of them.
 *
 * Consumers are the chunker pool and the enrichment executor (parent side) and
 * their worker entry modules (worker side). The in-process batch executor
 * (`WorkerPool`, `BatchAccumulator`) is a different concern and stays in
 * `pipeline/infra/`; neither side imports the other.
 */

export {
  defaultChunkerPoolSize,
  defaultEnrichmentFilesPerThread,
  defaultEnrichmentWorkerCpuProfileDir,
  defaultEnrichmentWorkerHeapSnapshotDir,
  defaultEnrichmentWorkerMemoryLimitMb,
  defaultEnrichmentWorkerStackSizeMb,
  defaultExtractionFanoutEnabled,
  defaultExtractionFanoutShardSize,
  defaultExtractionFanoutWorkers,
  defaultLanguageAffinityEnabled,
  defaultWorkerDispatchTimeoutMs,
} from "./pool-defaults.js";
export { ProcessTransport } from "./process-transport.js";
export { ThreadTransport } from "./thread-transport.js";
export { applyWorkerDebug } from "./worker-debug.js";
export { WorkerDispatchPool } from "./worker-dispatch-pool.js";
export { createWorkerRuntime, type WorkerRuntime } from "./worker-runtime.js";
export type { WorkerHandle, WorkerTransport } from "./worker-transport.js";
