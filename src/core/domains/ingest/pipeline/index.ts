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
export { initDebugLogger, pipelineLog } from "./infra/debug-logger.js";
export {
  defaultChunkerPoolSize,
  defaultEnrichmentFilesPerThread,
  defaultEnrichmentWorkerMemoryLimitMb,
} from "./infra/pool-defaults.js";
export { ChunkerPool } from "./chunker/infra/pool.js";
export { detectLanguage } from "./chunker/utils/language-detector.js";
export { WorkerPoolEnrichmentExecutor } from "./enrichment/executor/index.js";
export { buildFileChunkPoints } from "./file-chunk-points.js";
export { FileScanner } from "./scanner.js";
export { WorkerPool } from "./infra/worker-pool.js";
export { PipelineManager, createQdrantPipeline } from "./pipeline-manager.js";
export type { PipelineHandlers } from "./pipeline-manager.js";
export type { IngestDependencies } from "./dependencies.js";

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
  UpsertItem,
  WorkerPoolConfig,
  WorkItem,
} from "./infra/index.js";
export type { PipelineConfig, PipelineStats } from "./types.js";

export { buildPipelineConfig } from "./types.js";
