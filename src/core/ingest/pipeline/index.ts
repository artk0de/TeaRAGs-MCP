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
