/**
 * Pipeline Types - pipeline manager configuration and statistics.
 *
 * The batching / work-item vocabulary lives in `infra/types.ts`.
 */

import { IMPLICIT_EMBEDDING_CONCURRENCY_CEILING } from "./embedding-throughput-tuner.js";
import type { BatchAccumulatorConfig, WorkerPoolConfig } from "./infra/index.js";

/**
 * Pipeline manager configuration
 */
export interface PipelineConfig {
  /** Worker pool settings for upserts (embedding-bound) */
  workerPool: WorkerPoolConfig;
  /** Worker pool settings for deletes (Qdrant-bound, can be higher) */
  deleteWorkerPool: WorkerPoolConfig;
  /** Batch accumulator settings for upserts */
  upsertAccumulator: BatchAccumulatorConfig;
  /** Batch accumulator settings for deletes */
  deleteAccumulator: BatchAccumulatorConfig;
  /**
   * Let the embedding throughput tuner move the upsert batch size and the
   * upsert concurrency inside their configured bounds (bd tea-rags-mcp-7ju66).
   * Absent / false = the configured values for the whole run.
   */
  adaptiveEmbedding?: boolean;
  /**
   * Ceiling of the tuner's concurrency climb; `workerPool.concurrency` is where
   * it starts without a stored optimum. An explicit INGEST_PIPELINE_CONCURRENCY
   * is both; unset, the pool stays at 1 and the climb may reach
   * IMPLICIT_EMBEDDING_CONCURRENCY_CEILING. Absent = `workerPool.concurrency`.
   */
  embedConcurrencyCeiling?: number;
}

/**
 * Statistics for monitoring pipeline performance
 */
export interface PipelineStats {
  /** Total items processed */
  itemsProcessed: number;
  /** Total batches processed */
  batchesProcessed: number;
  /** Total errors encountered */
  errors: number;
  /** Current queue depth */
  queueDepth: number;
  /** Average batch processing time (ms) */
  avgBatchTimeMs: number;
  /** Items per second throughput */
  throughput: number;
  /** Time since pipeline started */
  uptimeMs: number;
}

/**
 * Build pipeline config from pre-parsed config slices.
 *
 * GPU Optimization for Ollama embeddings:
 * - LARGE batches = better GPU utilization (CUDA cores parallelize within batch)
 * - Optimal batch size: 256-512 for most GPUs (RTX 4090: 256 = 12,450 tokens/sec)
 * - Timeout is safety net for small codebases, not primary batch trigger
 *
 * Key insight: GPU works best when fed LARGE batches. Small frequent batches
 * cause GPU idle time between kernel launches. The problem is not batch size,
 * but ensuring chunks are generated FAST enough to fill batches quickly.
 */
export function buildPipelineConfig(
  pipelineConcurrency: number,
  embeddingTune: {
    batchSize: number;
    minBatchSize?: number;
    batchTimeoutMs: number;
    /** EMBEDDING_TUNE_STATIC — pin the configured batch size and concurrency. */
    static?: boolean;
  },
  qdrantTune: {
    deleteConcurrency: number;
    deleteBatchSize: number;
    deleteFlushTimeoutMs: number;
  },
  options: {
    /**
     * Whether INGEST_PIPELINE_CONCURRENCY (any spelling) was set explicitly.
     * Absent = explicit: `pipelineConcurrency` is the hard ceiling.
     */
    pipelineConcurrencyUserSet?: boolean;
  } = {},
): PipelineConfig {
  const embedConcurrencyCeiling =
    options.pipelineConcurrencyUserSet === false ? IMPLICIT_EMBEDDING_CONCURRENCY_CEILING : pipelineConcurrency;
  return {
    workerPool: {
      concurrency: pipelineConcurrency,
      maxRetries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 5000,
    },
    deleteWorkerPool: {
      concurrency: qdrantTune.deleteConcurrency,
      maxRetries: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 5000,
    },
    upsertAccumulator: {
      batchSize: embeddingTune.batchSize,
      minBatchSize: embeddingTune.minBatchSize,
      flushTimeoutMs: embeddingTune.batchTimeoutMs,
      maxQueueSize: pipelineConcurrency * 2,
    },
    deleteAccumulator: {
      batchSize: qdrantTune.deleteBatchSize,
      flushTimeoutMs: qdrantTune.deleteFlushTimeoutMs,
      maxQueueSize: qdrantTune.deleteConcurrency * 2,
    },
    adaptiveEmbedding: embeddingTune.static !== true,
    embedConcurrencyCeiling,
  };
}
