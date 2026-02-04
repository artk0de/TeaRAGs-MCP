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
      /** True for documentation chunks (markdown, etc.) */
      isDocumentation?: boolean;
      /** File-level imports (inherited by all chunks from the file) */
      imports?: string[];

      // Git metadata (canonical algorithm: aggregated signals only)
      git?: {
        lastModifiedAt: number;
        firstCreatedAt: number;
        dominantAuthor: string;
        dominantAuthorEmail: string;
        authors: string[];
        commitCount: number;
        lastCommitHash: string;
        ageDays: number;
        taskIds: string[];
      };
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
 * GPU Optimization for Ollama embeddings:
 * - LARGE batches = better GPU utilization (CUDA cores parallelize within batch)
 * - Optimal batch size: 256-512 for most GPUs (RTX 4090: 256 = 12,450 tokens/sec)
 * - Timeout is safety net for small codebases, not primary batch trigger
 *
 * Key insight: GPU works best when fed LARGE batches. Small frequent batches
 * cause GPU idle time between kernel launches. The problem is not batch size,
 * but ensuring chunks are generated FAST enough to fill batches quickly.
 */
export const DEFAULT_CONFIG: PipelineConfig = {
  workerPool: {
    // Concurrent embedding workers (parallel batches to Ollama)
    concurrency: parseInt(process.env.EMBEDDING_CONCURRENCY || "1", 10),
    maxRetries: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5000,
  },
  deleteWorkerPool: {
    // Delete is Qdrant-bound (not embedding), can use higher concurrency
    // QDRANT_DELETE_CONCURRENCY is the canonical name, DELETE_CONCURRENCY is deprecated but still supported
    concurrency: parseInt(process.env.QDRANT_DELETE_CONCURRENCY || process.env.DELETE_CONCURRENCY || "8", 10),
    maxRetries: 3,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 5000,
  },
  upsertAccumulator: {
    // Chunks to accumulate before sending to embedding
    // EMBEDDING_BATCH_SIZE is canonical, CODE_BATCH_SIZE is deprecated fallback
    batchSize: parseInt(process.env.EMBEDDING_BATCH_SIZE || process.env.CODE_BATCH_SIZE || "1024", 10),
    // Flush partial batch after timeout to avoid GPU idle time
    flushTimeoutMs: parseInt(process.env.BATCH_FORMATION_TIMEOUT_MS || "2000", 10),
    // Queue size based on concurrency
    maxQueueSize: parseInt(process.env.EMBEDDING_CONCURRENCY || "1", 10) * 2,
  },
  deleteAccumulator: {
    // Larger batches (500) are efficient with payload index on relativePath
    // QDRANT_DELETE_BATCH_SIZE is the canonical name, DELETE_BATCH_SIZE is deprecated but still supported
    batchSize: parseInt(process.env.QDRANT_DELETE_BATCH_SIZE || process.env.DELETE_BATCH_SIZE || "500", 10),
    // Faster flush for deletes (1s) - deletes are quick
    flushTimeoutMs: parseInt(process.env.DELETE_FLUSH_TIMEOUT_MS || "1000", 10),
    maxQueueSize: parseInt(process.env.QDRANT_DELETE_CONCURRENCY || process.env.DELETE_CONCURRENCY || "8", 10) * 2,
  },
};
