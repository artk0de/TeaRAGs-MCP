/**
 * ChunkPipeline - Specialized pipeline for chunk → embedding → Qdrant flow
 *
 * Solves the problem of uneven server load by:
 * 1. Accumulating chunks from multiple file processing threads
 * 2. Forming optimal batches (5s timeout for batch formation)
 * 3. Dispatching to bounded worker pool for embedding + storage
 *
 * Architecture:
 *   [File Thread 1] ─┐
 *   [File Thread 2] ─┼→ ChunkPipeline → BatchAccumulator → WorkerPool → Ollama/Qdrant
 *   [File Thread N] ─┘      (5s timeout)    (1s flush)     (bounded)
 */

import { extname, relative } from "node:path";

import type { EmbeddingProvider } from "../../embeddings/base.js";
import { BM25SparseVectorGenerator } from "../../embeddings/sparse.js";
import type { QdrantManager } from "../../qdrant/client.js";
import { BatchAccumulator } from "./batch-accumulator.js";
import { pipelineLog } from "./debug-logger.js";
import {
  DEFAULT_CONFIG,
  type Batch,
  type BatchAccumulatorConfig,
  type BatchResult,
  type ChunkItem,
  type PipelineStats,
  type WorkerPoolConfig,
} from "./types.js";
import { WorkerPool } from "./worker-pool.js";

const DEBUG = process.env.DEBUG === "true" || process.env.DEBUG === "1";
const LOG_CTX = { component: "ChunkPipeline" };

export interface ChunkPipelineConfig {
  /** Worker pool settings */
  workerPool: WorkerPoolConfig;
  /** Batch accumulator settings */
  accumulator: BatchAccumulatorConfig;
  /** Enable hybrid search (sparse vectors) */
  enableHybrid: boolean;
}

export class ChunkPipeline {
  private readonly config: ChunkPipelineConfig;
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly collectionName: string;
  private readonly sparseGenerator: BM25SparseVectorGenerator | null;

  private readonly workerPool: WorkerPool;
  private readonly accumulator: BatchAccumulator<ChunkItem>;
  private pendingBatches: Promise<BatchResult>[] = [];

  private onBatchUpsertedCb?: (items: ChunkItem[]) => void;
  private isRunning = false;
  private readonly stats = {
    chunksProcessed: 0,
    batchesProcessed: 0,
    errors: 0,
    startTime: 0,
  };

  constructor(
    qdrant: QdrantManager,
    embeddings: EmbeddingProvider,
    collectionName: string,
    config?: Partial<ChunkPipelineConfig>,
  ) {
    this.qdrant = qdrant;
    this.embeddings = embeddings;
    this.collectionName = collectionName;

    this.config = {
      workerPool: config?.workerPool ?? DEFAULT_CONFIG.workerPool,
      accumulator: config?.accumulator ?? DEFAULT_CONFIG.upsertAccumulator,
      enableHybrid: config?.enableHybrid ?? false,
    };

    this.sparseGenerator = this.config.enableHybrid ? new BM25SparseVectorGenerator() : null;

    // Initialize worker pool
    this.workerPool = new WorkerPool(
      this.config.workerPool,
      (result) => {
        this.onBatchComplete(result);
      },
      (queueSize) => {
        this.onQueueChange(queueSize);
      },
    );

    // Initialize accumulator
    this.accumulator = new BatchAccumulator(this.config.accumulator, "upsert", (batch) => {
      this.submitBatch(batch);
    });
  }

  /**
   * Register a callback that fires after each successful batch upsert.
   * Used by EnrichmentModule to stream git metadata as chunks are stored.
   */
  setOnBatchUpserted(cb: (items: ChunkItem[]) => void): void {
    this.onBatchUpsertedCb = cb;
  }

  /**
   * Start the pipeline
   */
  start(): void {
    if (this.isRunning) return;

    this.isRunning = true;
    this.stats.startTime = Date.now();

    pipelineLog.step(LOG_CTX, "PIPELINE_START", {
      workers: this.config.workerPool.concurrency,
      batchSize: this.config.accumulator.batchSize,
      flushTimeoutMs: this.config.accumulator.flushTimeoutMs,
      hybrid: this.config.enableHybrid,
      collection: this.collectionName,
    });

    if (DEBUG) {
      console.error(
        `[ChunkPipeline] Started: ` +
          `workers=${this.config.workerPool.concurrency}, ` +
          `batchSize=${this.config.accumulator.batchSize}, ` +
          `flushTimeout=${this.config.accumulator.flushTimeoutMs}ms`,
      );
    }
  }

  /**
   * Add a chunk for processing
   * @returns true if accepted, false if backpressure active
   */
  addChunk(chunk: ChunkItem["chunk"], chunkId: string, codebasePath: string): boolean {
    if (!this.isRunning) {
      throw new Error("ChunkPipeline not started");
    }

    const item: ChunkItem = {
      type: "upsert",
      id: chunkId,
      chunk,
      chunkId,
      codebasePath,
    };

    return this.accumulator.add(item);
  }

  /**
   * Add multiple chunks for processing
   * @returns number of items accepted
   */
  addChunks(
    chunks: {
      chunk: ChunkItem["chunk"];
      chunkId: string;
      codebasePath: string;
    }[],
  ): number {
    let accepted = 0;
    for (const { chunk, chunkId, codebasePath } of chunks) {
      if (this.addChunk(chunk, chunkId, codebasePath)) {
        accepted++;
      } else {
        break;
      }
    }
    return accepted;
  }

  /**
   * Check if backpressure is active
   */
  isBackpressured(): boolean {
    return this.accumulator.isPausedState();
  }

  /**
   * Wait for backpressure to release
   * @param timeout Maximum time to wait (ms)
   * @returns true if released, false if timeout
   */
  async waitForBackpressure(timeout = 30000): Promise<boolean> {
    const startTime = Date.now();

    while (this.isBackpressured()) {
      if (Date.now() - startTime > timeout) {
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    return true;
  }

  /**
   * Flush all pending chunks and wait for completion
   */
  async flush(): Promise<void> {
    this.accumulator.drain();
    await this.workerPool.drain();
    await Promise.all(this.pendingBatches);
    this.pendingBatches = [];
  }

  /**
   * Gracefully shutdown the pipeline
   */
  async shutdown(): Promise<void> {
    if (!this.isRunning) return;

    pipelineLog.step(LOG_CTX, "PIPELINE_SHUTDOWN_START");

    await this.flush();
    await this.workerPool.shutdown();
    this.isRunning = false;

    const stats = this.getStats();
    pipelineLog.summary(LOG_CTX, {
      chunksProcessed: stats.itemsProcessed,
      batchesProcessed: stats.batchesProcessed,
      errors: stats.errors,
      uptimeMs: stats.uptimeMs,
      throughput: stats.throughput,
      avgBatchTimeMs: stats.avgBatchTimeMs,
    });

    if (DEBUG) {
      console.error(
        `[ChunkPipeline] Shutdown: ${stats.itemsProcessed} chunks, ` +
          `${stats.batchesProcessed} batches, ${stats.errors} errors ` +
          `in ${(stats.uptimeMs / 1000).toFixed(1)}s ` +
          `(${stats.throughput.toFixed(1)} chunks/s)`,
      );
    }
  }

  /**
   * Force shutdown (cancel pending work)
   */
  forceShutdown(): void {
    this.isRunning = false;
    this.accumulator.clear();
    this.workerPool.forceShutdown();
    this.pendingBatches = [];
  }

  /**
   * Get pipeline statistics
   */
  getStats(): PipelineStats {
    const poolStats = this.workerPool.getStats();
    const uptimeMs = this.stats.startTime > 0 ? Date.now() - this.stats.startTime : 0;

    return {
      itemsProcessed: this.stats.chunksProcessed,
      batchesProcessed: this.stats.batchesProcessed,
      errors: this.stats.errors,
      queueDepth: poolStats.queueDepth,
      avgBatchTimeMs: poolStats.avgTimeMs,
      throughput: uptimeMs > 0 ? (this.stats.chunksProcessed / uptimeMs) * 1000 : 0,
      uptimeMs,
    };
  }

  /**
   * Get pending count (chunks waiting to be batched)
   */
  getPendingCount(): number {
    return this.accumulator.getPendingCount();
  }

  private submitBatch(batch: Batch<ChunkItem>): void {
    const handler = this.createBatchHandler();
    const promise = this.workerPool.submit(batch, handler);
    this.pendingBatches.push(promise);

    // Cleanup completed promises periodically
    if (this.pendingBatches.length > 100) {
      this.pendingBatches = this.pendingBatches.filter((p) => !this.isPromiseResolved(p));
    }
  }

  /**
   * Create a batch handler that embeds chunks and stores to Qdrant
   */
  private createBatchHandler(): (batch: Batch<ChunkItem>) => Promise<void> {
    return async (batch: Batch<ChunkItem>) => {
      const ctx = { ...LOG_CTX, batchId: batch.id };

      pipelineLog.batchStart(ctx, batch.id, batch.items.length);

      // 1. Extract texts for embedding
      const texts = batch.items.map((item) => item.chunk.content);

      // 2. Generate embeddings
      const embedStart = Date.now();
      const embeddings = await this.embeddings.embedBatch(texts);
      const embedDuration = Date.now() - embedStart;
      pipelineLog.embedCall(ctx, texts.length, embedDuration);
      pipelineLog.addStageTime("embed", embedDuration);

      // 3. Build points
      const points = batch.items.map((item, idx) => {
        const relativePath = relative(item.codebasePath, item.chunk.metadata.filePath);

        return {
          id: item.chunkId,
          vector: embeddings[idx].embedding,
          payload: {
            content: item.chunk.content,
            relativePath,
            startLine: item.chunk.startLine,
            endLine: item.chunk.endLine,
            fileExtension: extname(item.chunk.metadata.filePath),
            language: item.chunk.metadata.language,
            codebasePath: item.codebasePath,
            chunkIndex: item.chunk.metadata.chunkIndex,
            ...(item.chunk.metadata.name && { name: item.chunk.metadata.name }),
            ...(item.chunk.metadata.chunkType && {
              chunkType: item.chunk.metadata.chunkType,
            }),
            ...(item.chunk.metadata.parentName && {
              parentName: item.chunk.metadata.parentName,
            }),
            ...(item.chunk.metadata.parentType && {
              parentType: item.chunk.metadata.parentType,
            }),
            ...(item.chunk.metadata.symbolId && {
              symbolId: item.chunk.metadata.symbolId,
            }),
            ...(item.chunk.metadata.isDocumentation && {
              isDocumentation: item.chunk.metadata.isDocumentation,
            }),
            // File-level imports (inherited by all chunks from the file)
            ...(item.chunk.metadata.imports?.length && {
              imports: item.chunk.metadata.imports,
            }),
            // Git metadata (canonical algorithm: nested git object with aggregated signals)
            ...(item.chunk.metadata.git && {
              git: {
                lastModifiedAt: item.chunk.metadata.git.lastModifiedAt,
                firstCreatedAt: item.chunk.metadata.git.firstCreatedAt,
                dominantAuthor: item.chunk.metadata.git.dominantAuthor,
                dominantAuthorEmail: item.chunk.metadata.git.dominantAuthorEmail,
                authors: item.chunk.metadata.git.authors,
                commitCount: item.chunk.metadata.git.commitCount,
                lastCommitHash: item.chunk.metadata.git.lastCommitHash,
                ageDays: item.chunk.metadata.git.ageDays,
                taskIds: item.chunk.metadata.git.taskIds,
              },
            }),
          },
        };
      });

      // 4. Store to Qdrant
      const qdrantStart = Date.now();
      if (this.sparseGenerator) {
        const hybridPoints = points.map((point, idx) => ({
          ...point,
          sparseVector: this.sparseGenerator?.generate(batch.items[idx].chunk.content) ?? { indices: [], values: [] },
        }));
        await this.qdrant.addPointsWithSparse(this.collectionName, hybridPoints);
        const qdrantDurationHybrid = Date.now() - qdrantStart;
        pipelineLog.qdrantCall(ctx, "UPSERT_HYBRID", points.length, qdrantDurationHybrid);
        pipelineLog.addStageTime("qdrant", qdrantDurationHybrid);
      } else {
        await this.qdrant.addPointsOptimized(this.collectionName, points, {
          wait: false,
          ordering: "weak",
        });
        const qdrantDuration = Date.now() - qdrantStart;
        pipelineLog.qdrantCall(ctx, "UPSERT", points.length, qdrantDuration);
        pipelineLog.addStageTime("qdrant", qdrantDuration);
      }

      // 5. Notify callback after successful upsert (for streaming enrichment)
      this.onBatchUpsertedCb?.(batch.items);
    };
  }

  private onBatchComplete(result: BatchResult): void {
    this.stats.batchesProcessed++;
    this.stats.chunksProcessed += result.itemCount;

    const ctx = { ...LOG_CTX, batchId: result.batchId };

    if (!result.success) {
      this.stats.errors++;
      pipelineLog.batchFailed(
        ctx,
        result.batchId,
        result.error || "Unknown error",
        result.retryCount || 0,
        this.config.workerPool.maxRetries,
      );
      if (DEBUG) {
        console.error(`[ChunkPipeline] Batch ${result.batchId} failed: ${result.error}`);
      }
    } else {
      pipelineLog.batchComplete(ctx, result.batchId, result.itemCount, result.durationMs, result.retryCount || 0);
      if (DEBUG) {
        console.error(
          `[ChunkPipeline] Batch ${result.batchId} complete: ${result.itemCount} chunks in ${result.durationMs}ms`,
        );
      }
    }
  }

  private onQueueChange(queueSize: number): void {
    const maxQueue = this.config.accumulator.maxQueueSize;
    const activeWorkers = this.workerPool.getActiveWorkers();
    const pendingItems = this.accumulator.getPendingCount();

    pipelineLog.queueState(LOG_CTX, queueSize, activeWorkers, pendingItems);

    if (queueSize >= maxQueue) {
      pipelineLog.backpressure(LOG_CTX, true, `queueSize(${queueSize}) >= maxQueue(${maxQueue})`);
      this.accumulator.pause();
    } else if (queueSize < maxQueue * 0.5) {
      if (this.accumulator.isPausedState()) {
        pipelineLog.backpressure(LOG_CTX, false, `queueSize(${queueSize}) < threshold(${maxQueue * 0.5})`);
      }
      this.accumulator.resume();
    }
  }

  private isPromiseResolved(promise: Promise<unknown>): boolean {
    let resolved = false;
    Promise.race([promise.then(() => (resolved = true)), Promise.resolve()]).catch(() => {});
    return resolved;
  }
}
