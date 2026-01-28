/**
 * Pipeline Types - Interfaces for the batching/worker pool system
 */

/**
 * Types of operations the pipeline can handle
 */
export type OperationType = "upsert" | "delete";

/**
 * Base work item interface
 */
export interface WorkItem {
  type: OperationType;
  id: string;
}

/**
 * Upsert operation - add or update points in Qdrant
 */
export interface UpsertItem extends WorkItem {
  type: "upsert";
  point: {
    id: string;
    vector: number[];
    sparseVector?: { indices: number[]; values: number[] };
    payload: Record<string, unknown>;
  };
}

/**
 * Chunk operation - raw chunk needing embedding before upsert
 * Used by ChunkPipeline for batched embedding + storage
 */
export interface ChunkItem extends WorkItem {
  type: "upsert";
  chunk: {
    content: string;
    startLine: number;
    endLine: number;
    metadata: {
      filePath: string;
      language: string;
      chunkIndex: number;
      name?: string;
      chunkType?: string;
      /** Parent class/module name for methods extracted from large classes */
      parentName?: string;
      /** Parent AST node type (e.g., "class", "module") */
      parentType?: string;
    };
  };
  /** Pre-computed chunk ID */
  chunkId: string;
  /** Absolute path of the codebase for relativePath calculation */
  codebasePath: string;
}

/**
 * Delete operation - remove points by path filter
 */
export interface DeleteItem extends WorkItem {
  type: "delete";
  relativePath: string;
}

/**
 * Batch of work items ready for processing
 */
export interface Batch<T extends WorkItem = WorkItem> {
  id: string;
  type: OperationType;
  items: T[];
  createdAt: number;
}

/**
 * Result of processing a batch
 */
export interface BatchResult {
  batchId: string;
  type: OperationType;
  success: boolean;
  itemCount: number;
  durationMs: number;
  error?: string;
  retryCount?: number;
}

/**
 * Worker pool configuration
 */
export interface WorkerPoolConfig {
  /** Number of concurrent workers */
  concurrency: number;
  /** Maximum retries per batch */
  maxRetries: number;
  /** Base delay for exponential backoff (ms) */
  retryBaseDelayMs: number;
  /** Maximum delay between retries (ms) */
  retryMaxDelayMs: number;
}

/**
 * Batch accumulator configuration
 */
export interface BatchAccumulatorConfig {
  /** Target batch size */
  batchSize: number;
  /** Flush timeout (ms) - send partial batch after this time */
  flushTimeoutMs: number;
  /** Maximum queue size before applying backpressure */
  maxQueueSize: number;
}

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
 * Callback for batch completion
 */
export type BatchCompletionCallback = (result: BatchResult) => void;

/**
 * Callback for backpressure events
 */
export type BackpressureCallback = (isPaused: boolean) => void;

/**
 * Handler function for processing batches
 */
export type BatchHandler<T extends WorkItem> = (
  batch: Batch<T>,
) => Promise<void>;

/**
 * Default configuration values
 *
 * Tuning notes:
 * - BATCH_FORMATION_TIMEOUT_MS: Time to wait for batch to fill before flushing
 *   Higher = better batching efficiency, lower = faster response
 * - WORKER_FLUSH_TIMEOUT_MS: Time before WorkerPool flushes partial work
 *   Higher = more even load distribution
 * - DELETE_CONCURRENCY: Separate from EMBEDDING_CONCURRENCY because delete
 *   operations are Qdrant-bound (not embedding-bound), so can be higher
 * - DELETE_BATCH_SIZE: Larger batches (500) with payload index are efficient
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  workerPool: {
    concurrency: parseInt(process.env.EMBEDDING_CONCURRENCY || "4", 10),
    maxRetries: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5000,
  },
  deleteWorkerPool: {
    // Delete is Qdrant-bound (not embedding), so can use higher concurrency
    concurrency: parseInt(process.env.DELETE_CONCURRENCY || "8", 10),
    maxRetries: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5000,
  },
  upsertAccumulator: {
    batchSize: parseInt(process.env.CODE_BATCH_SIZE || "50", 10),
    // Longer timeout (5s) for batch formation - allows more items to accumulate
    flushTimeoutMs: parseInt(process.env.BATCH_FORMATION_TIMEOUT_MS || "5000", 10),
    maxQueueSize: parseInt(process.env.EMBEDDING_CONCURRENCY || "4", 10) * 2,
  },
  deleteAccumulator: {
    // Larger batches (500) are efficient with payload index on relativePath
    batchSize: parseInt(process.env.DELETE_BATCH_SIZE || "500", 10),
    // Faster flush for deletes (1s) - deletes are quick
    flushTimeoutMs: parseInt(process.env.DELETE_FLUSH_TIMEOUT_MS || "1000", 10),
    maxQueueSize: parseInt(process.env.DELETE_CONCURRENCY || "8", 10) * 2,
  },
};
