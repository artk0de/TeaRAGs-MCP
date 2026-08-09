/**
 * Pipeline module exports
 *
 * Provides batching and worker pool functionality for efficient
 * Qdrant operations with bounded concurrency and backpressure.
 */

// Core components
export { ChunkPipeline } from "./chunk-pipeline.js";
export type { ChunkPipelineConfig } from "./chunk-pipeline.js";
export { BatchAccumulator } from "./infra/batch-accumulator.js";
// Marker liveness — read by `infra/alias-cleanup` to tell a half-built
// collection apart from an abandoned one, so it crosses the subdomain boundary.
export { isIndexingRunStale, parseMarkerPayload, STALE_INDEXING_THRESHOLD_MS } from "./indexing-marker-codec.js";
export type { IndexingMarkerPayload } from "./indexing-marker-codec.js";
export { pipelineLog } from "./infra/debug-logger.js";
export { WorkerPool } from "./infra/worker-pool.js";
export { PipelineManager, createQdrantPipeline } from "./pipeline-manager.js";
export type { PipelineHandlers } from "./pipeline-manager.js";

// Types
export type {
  Batch,
  BatchAccumulatorConfig,
  BatchCompletionCallback,
  BatchHandler,
  BatchResult,
  BackpressureCallback,
  ChunkItem,
  DeleteItem,
  OperationType,
  PipelineConfig,
  PipelineStats,
  UpsertItem,
  WorkerPoolConfig,
  WorkItem,
} from "./types.js";

export { buildPipelineConfig } from "./types.js";
