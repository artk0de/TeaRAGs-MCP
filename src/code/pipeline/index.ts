/**
 * Pipeline module exports
 *
 * Provides batching and worker pool functionality for efficient
 * Qdrant operations with bounded concurrency and backpressure.
 */

// Core components
export { BatchAccumulator } from "./batch-accumulator.js";
export { ChunkPipeline } from "./chunk-pipeline.js";
export type { ChunkPipelineConfig } from "./chunk-pipeline.js";
export { pipelineLog } from "./debug-logger.js";
export { PipelineManager, createQdrantPipeline } from "./pipeline-manager.js";
export type { PipelineHandlers } from "./pipeline-manager.js";
export { WorkerPool } from "./worker-pool.js";

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

export { DEFAULT_CONFIG } from "./types.js";
