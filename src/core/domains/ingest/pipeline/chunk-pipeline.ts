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

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { generateSparseVector } from "../../../adapters/qdrant/sparse.js";
import type { PayloadBuilder } from "../../../contracts/types/provider.js";
import type { EmbeddingProducerStarvation } from "../../../contracts/types/registry.js";
import { isDebug } from "../../../infra/runtime.js";
import { PipelineNotStartedError } from "../errors.js";
import { classifyEmbeddingQuarantinable, type QuarantineStore } from "../sync/index.js";
import { AdaptiveBatchSizer } from "./adaptive-batch-sizer.js";
import {
  PRODUCER_STARVED_BATCH_SHARE,
  type EmbeddingEndpointIdentity,
  type EmbeddingEndpointThroughputOptimum,
  type EmbeddingThroughputDecision,
  type EmbeddingThroughputTuner,
} from "./embedding-throughput-tuner.js";
import { BatchAccumulator } from "./infra/batch-accumulator.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { WorkerPool } from "./infra/worker-pool.js";
import type {
  Batch,
  BatchAccumulatorConfig,
  BatchResult,
  ChunkItem,
  PipelineStats,
  WorkerPoolConfig,
} from "./types.js";

const LOG_CTX = { component: "ChunkPipeline" };

/** Enrich OllamaContextOverflowError with the file/chunk that likely caused the overflow. */
function enrichContextOverflowError(error: unknown, items: ChunkItem[]): unknown {
  // Only enrich context overflow errors — other errors pass through unchanged
  if (!error || typeof error !== "object" || !("code" in error)) return error;
  if ((error as { code: string }).code !== "INFRA_OLLAMA_CONTEXT_OVERFLOW") return error;
  if (items.length === 0) return error;

  const largest = items.reduce((max, item) => (item.chunk.content.length > max.chunk.content.length ? item : max));
  const context =
    `\nLargest chunk: ${largest.chunk.metadata.filePath}:${largest.chunk.startLine}-${largest.chunk.endLine}` +
    ` (${largest.chunk.content.length} chars)`;
  Object.defineProperty(error, "message", { value: (error as unknown as Error).message + context });
  return error;
}

export interface ChunkPipelineConfig {
  /** Worker pool settings */
  workerPool: WorkerPoolConfig;
  /** Batch accumulator settings */
  accumulator: BatchAccumulatorConfig;
  /** Enable hybrid search (sparse vectors) */
  enableHybrid: boolean;
  /**
   * Owner of the embed batch size and concurrency (bd tea-rags-mcp-7ju66).
   * Absent = today's static behaviour (`EMBEDDING_TUNE_STATIC`): the configured
   * batch size and concurrency for the whole run.
   */
  throughputTuner?: EmbeddingThroughputTuner;
}

export class ChunkPipeline {
  private readonly config: ChunkPipelineConfig;
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly collectionName: string;
  private readonly payloadBuilder: PayloadBuilder;
  private readonly enableHybrid: boolean;

  private readonly workerPool: WorkerPool;
  private readonly accumulator: BatchAccumulator<ChunkItem>;
  private readonly batchSizer: AdaptiveBatchSizer;
  private readonly throughputTuner?: EmbeddingThroughputTuner;
  /** Batch size the tuner asks for; the accumulator uses min(this, Qdrant sizer). */
  private tunedBatchSize: number;
  private detachServerBatchFailures?: () => void;
  private pendingBatches: Promise<BatchResult>[] = [];

  private onBatchUpsertedCb?: (items: ChunkItem[]) => void;
  private onProgressCb?: (itemsProcessed: number, throughput: number) => void;
  private quarantineStore?: QuarantineStore;
  private isRunning = false;
  private readonly stats = {
    chunksProcessed: 0,
    batchesProcessed: 0,
    errors: 0,
    startTime: 0,
  };
  /** Embed batches formed by size or timeout, and the producer-starved ones among them (bd tea-rags-mcp-y1ynz). */
  private readonly batchFormation = { formed: 0, starved: 0 };

  constructor(
    qdrant: QdrantManager,
    embeddings: EmbeddingProvider,
    collectionName: string,
    payloadBuilder: PayloadBuilder,
    config?: Partial<ChunkPipelineConfig>,
  ) {
    this.qdrant = qdrant;
    this.embeddings = embeddings;
    this.collectionName = collectionName;
    this.payloadBuilder = payloadBuilder;

    this.config = {
      workerPool: config?.workerPool ?? {
        concurrency: 1,
        maxRetries: 3,
        retryBaseDelayMs: 100,
        retryMaxDelayMs: 5000,
      },
      accumulator: config?.accumulator ?? {
        batchSize: 1024,
        flushTimeoutMs: 2000,
        maxQueueSize: 2,
      },
      enableHybrid: config?.enableHybrid ?? false,
    };

    this.enableHybrid = this.config.enableHybrid;

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

    // Initialize accumulator. It gets its own copy of the config: `updateBatchSize`
    // mutates it in place, and the caller's object is the run-spanning tuning.
    this.accumulator = new BatchAccumulator({ ...this.config.accumulator }, "upsert", (batch) => {
      this.submitBatch(batch);
    });

    // Adaptive batch sizer — reacts to Qdrant yellow (halve) and recovery (double).
    // Floor = max(32, initial/16) so very small configured batchSizes still degrade gracefully.
    const initialBatchSize = this.config.accumulator.batchSize;
    this.batchSizer = new AdaptiveBatchSizer({
      initial: initialBatchSize,
      min: Math.max(32, Math.floor(initialBatchSize / 16)),
      recoveryThreshold: 5,
    });

    this.throughputTuner = config?.throughputTuner;
    this.tunedBatchSize = initialBatchSize;
  }

  /**
   * Register a callback that fires after each successful batch upsert.
   * Used by EnrichmentModule to stream git metadata as chunks are stored.
   */
  setOnBatchUpserted(cb: (items: ChunkItem[]) => void): void {
    this.onBatchUpsertedCb = cb;
  }

  /**
   * Register a callback that fires after each successful batch upsert with
   * cumulative stored-chunk count and current throughput. Used to drive real
   * embedding progress (as opposed to chunking cadence).
   */
  setOnProgress(cb: (itemsProcessed: number, throughput: number) => void): void {
    this.onProgressCb = cb;
  }

  /**
   * Wire poison-pill quarantine. When set, a chunk whose embedding fails with a
   * quarantinable error (context overflow, 4xx) is isolated from its batch and
   * its file recorded — instead of aborting the whole indexing pass.
   */
  setQuarantineStore(store: QuarantineStore): void {
    this.quarantineStore = store;
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
      adaptiveEmbedding: this.throughputTuner !== undefined,
    });

    const tuner = this.throughputTuner;
    if (tuner) {
      // A size failure the provider absorbs by halving internally never fails
      // the call, so it reaches the tuner only through this hook.
      this.detachServerBatchFailures = this.embeddings.observeServerBatchFailures?.((event) => {
        this.applyThroughputDecision(
          tuner.observe({
            size: event.failedSize,
            inputChars: 0,
            durationMs: 0,
            ok: false,
            endpoint: this.currentEmbeddingEndpoint(event.endpointUrl),
          }),
        );
      });
      this.applyThroughputDecision(tuner.begin(this.currentEmbeddingEndpoint()));
    }

    if (isDebug()) {
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
      throw new PipelineNotStartedError("ChunkPipeline");
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
    const settled = await Promise.allSettled(this.pendingBatches);
    this.pendingBatches = [];
    const firstRejection = settled.find((r) => r.status === "rejected");
    if (firstRejection?.status === "rejected") {
      throw firstRejection.reason;
    }
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
    this.detachFromProvider();

    pipelineLog.step(LOG_CTX, "EMBED_PRODUCER_STARVATION", { ...this.embeddingProducerStarvation() });

    const stats = this.getStats();
    pipelineLog.summary(LOG_CTX, {
      chunksProcessed: stats.itemsProcessed,
      batchesProcessed: stats.batchesProcessed,
      errors: stats.errors,
      uptimeMs: stats.uptimeMs,
      throughput: stats.throughput,
      avgBatchTimeMs: stats.avgBatchTimeMs,
    });

    if (isDebug()) {
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
    this.detachFromProvider();
  }

  /**
   * The embed batch shapes the throughput tuner settled on this run, one per
   * endpoint + model — what the run records into the project registry so the
   * next run starts there. Empty without a tuner or when nothing settled.
   */
  settledThroughputOptima(): EmbeddingEndpointThroughputOptimum[] {
    return this.throughputTuner?.settledOptima() ?? [];
  }

  /**
   * Whether this run's embed stage waited on the chunk producer rather than on
   * the embedding server (bd tea-rags-mcp-y1ynz): the batches formed by size or
   * by the formation timeout, and how many of them the timeout flushed below
   * target while an embed slot sat idle. The drain tail is not counted — every
   * run ends on one partial batch.
   */
  embeddingProducerStarvation(): EmbeddingProducerStarvation {
    const { formed, starved } = this.batchFormation;
    return {
      formedBatches: formed,
      starvedBatches: starved,
      producerStarved: formed > 0 && starved / formed >= PRODUCER_STARVED_BATCH_SHARE,
    };
  }

  /**
   * Judge a batch the accumulator just formed, BEFORE it is submitted: a
   * timeout flush below target while the worker pool has a free slot and
   * nothing queued means the server is waiting for input. A timeout flush into
   * a saturated pool is server-bound — its items waited on the embed stage.
   * Undefined for a drain or a batch built outside the accumulator.
   */
  private judgeProducerStarvation(batch: Batch<ChunkItem>): boolean | undefined {
    if (batch.flushTrigger !== "size" && batch.flushTrigger !== "timeout") return undefined;
    const starved =
      batch.flushTrigger === "timeout" &&
      !this.workerPool.isAtCapacity() &&
      this.workerPool.getStats().queueDepth === 0;
    this.batchFormation.formed++;
    if (starved) this.batchFormation.starved++;
    return starved;
  }

  /** Feed one embed call to the tuner (no-op without one) and apply what it decides. */
  private observeEmbedBatch(
    size: number,
    inputChars: number,
    durationMs: number,
    ok: boolean,
    producerStarved?: boolean,
  ): void {
    const tuner = this.throughputTuner;
    if (!tuner) return;
    this.applyThroughputDecision(
      tuner.observe({
        size,
        inputChars,
        durationMs,
        ok,
        endpoint: this.currentEmbeddingEndpoint(),
        ...(producerStarved !== undefined ? { producerStarved } : {}),
      }),
    );
  }

  private detachFromProvider(): void {
    this.detachServerBatchFailures?.();
    this.detachServerBatchFailures = undefined;
  }

  /**
   * The embedding identity the next embed goes to, as the tuner keys it:
   * provider + endpoint (the whole set, for a fan-out provider) + model (bd
   * tea-rags-mcp-y1ynz). `url` is one endpoint a failure event names.
   */
  private currentEmbeddingEndpoint(url?: string): EmbeddingEndpointIdentity {
    const endpointUrl = this.embeddings.getThroughputTuneEndpointUrl?.(url) ?? url ?? this.embeddings.getBaseUrl?.();
    const provider = this.embeddings.getProviderName?.();
    return {
      ...(provider !== undefined ? { provider } : {}),
      ...(endpointUrl !== undefined ? { url: endpointUrl } : {}),
      model: this.embeddings.getModel(),
    };
  }

  /**
   * Push a tuner decision into the accumulator and the worker pool, and log
   * every change the tuner made. The accumulator size is the smaller of the
   * tuner's and the Qdrant yellow sizer's — two governors, one batch.
   */
  private applyThroughputDecision(decision: EmbeddingThroughputDecision): void {
    for (const adaptation of this.throughputTuner?.drainAdaptations() ?? []) {
      pipelineLog.step(LOG_CTX, "EMBED_TUNE_ADAPTED", { ...adaptation });
    }
    this.tunedBatchSize = decision.batchSize;
    this.accumulator.updateBatchSize(Math.min(this.tunedBatchSize, this.batchSizer.current()));
    this.workerPool.setConcurrency(decision.concurrency);
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
    const handler = this.createBatchHandler(this.judgeProducerStarvation(batch));
    const promise = this.workerPool.submit(batch, handler);
    // Prevent unhandled rejection — errors are collected in flush() via allSettled
    promise.catch(() => {});
    this.pendingBatches.push(promise);

    // Cleanup completed promises periodically
    if (this.pendingBatches.length > 100) {
      this.pendingBatches = this.pendingBatches.filter((p) => !this.isPromiseResolved(p));
    }
  }

  /**
   * Create a batch handler that embeds chunks and stores to Qdrant.
   * `producerStarved` is the formation verdict of the batch it will run
   * (`judgeProducerStarvation`), handed to the tuner with the measurement.
   */
  private createBatchHandler(producerStarved?: boolean): (batch: Batch<ChunkItem>) => Promise<void> {
    return async (batch: Batch<ChunkItem>) => {
      const ctx = { ...LOG_CTX, batchId: batch.id };

      pipelineLog.batchStart(ctx, batch.id, batch.items.length);

      // 1. Extract texts for embedding
      let { items } = batch;
      const texts = items.map((item) => item.chunk.content);

      // 2. Generate embeddings
      const embedStart = Date.now();
      let embeddings: Awaited<ReturnType<EmbeddingProvider["embedBatch"]>>;
      // A bisected batch's wall clock is not a throughput sample of its size.
      let isolated = false;
      try {
        embeddings = await this.embeddings.embedBatch(texts);
      } catch (error) {
        const wrapped = enrichContextOverflowError(error, items);
        // Quarantinable embedding failure (context overflow, 4xx): isolate the
        // poison chunk(s) from the batch instead of aborting the whole pass.
        const quarantinable = this.quarantineStore ? classifyEmbeddingQuarantinable(wrapped, "") : null;
        if (!quarantinable) throw wrapped;
        const sent = items.length;
        ({ items, embeddings } = await this.isolateEmbeddingFailures(items, wrapped));
        // Every chunk survived the bisection: the server rejected the BATCH, not
        // any chunk in it (bd tea-rags-mcp-nu05a) — a size fact for the tuner.
        if (items.length === sent) this.observeEmbedBatch(sent, 0, 0, false);
        if (items.length === 0) {
          // Every chunk in the batch was quarantined — nothing left to store.
          return;
        }
        isolated = true;
      }
      const embedDuration = Date.now() - embedStart;
      if (!isolated) {
        const inputChars = texts.reduce((sum, text) => sum + text.length, 0);
        this.observeEmbedBatch(texts.length, inputChars, embedDuration, true, producerStarved);
      }
      pipelineLog.embedCall(ctx, texts.length, embedDuration);
      pipelineLog.addStageTime("embed", embedDuration);

      // 3. Build points
      const points = items.map((item, idx) => ({
        id: item.chunkId,
        vector: embeddings[idx].embedding,
        payload: this.payloadBuilder.buildPayload(item.chunk, item.codebasePath),
      }));

      // 4. Store to Qdrant — wrap in try/catch so AdaptiveBatchSizer observes
      // both success (drives recovery) and yellow failures (halves batch size).
      // We re-throw so WorkerPool's retry logic stays intact.
      const qdrantStart = Date.now();
      if (this.enableHybrid) {
        const hybridPoints = points.map((point, idx) => ({
          ...point,
          sparseVector: generateSparseVector(items[idx].chunk.content),
        }));
        try {
          await this.qdrant.addPointsWithSparse(this.collectionName, hybridPoints);
          this.onSizerSuccess();
        } catch (error) {
          this.onSizerFailure(error);
          throw error;
        }
        const qdrantDurationHybrid = Date.now() - qdrantStart;
        pipelineLog.qdrantCall(ctx, "UPSERT_HYBRID", points.length, qdrantDurationHybrid);
        pipelineLog.addStageTime("qdrant", qdrantDurationHybrid);
      } else {
        try {
          await this.qdrant.addPointsOptimized(this.collectionName, points, {
            wait: false,
            ordering: "weak",
          });
          this.onSizerSuccess();
        } catch (error) {
          this.onSizerFailure(error);
          throw error;
        }
        const qdrantDuration = Date.now() - qdrantStart;
        pipelineLog.qdrantCall(ctx, "UPSERT", points.length, qdrantDuration);
        pipelineLog.addStageTime("qdrant", qdrantDuration);
      }

      // 5. Notify callback after successful upsert (for streaming enrichment)
      this.onBatchUpsertedCb?.(items);
    };
  }

  /**
   * Find the poison chunk(s) of a batch whose `embedBatch` already failed with
   * a quarantinable error, by recursive bisection: the failed batch is NOT
   * resent; its two halves are embedded as one request each, a failing half is
   * split again, and a failing single chunk has its file recorded in the
   * quarantine and is dropped. One poison chunk in n costs O(log n) requests;
   * a batch-level failure that does not reproduce on the halves costs exactly
   * two. Survivors are returned in input order with index-aligned embeddings.
   * A non-quarantinable failure is rethrown so the WorkerPool retries the
   * whole batch.
   *
   * `failure` is the error `embedBatch(items)` already threw — `items` is
   * never resent as a whole.
   */
  private async isolateEmbeddingFailures(
    items: ChunkItem[],
    failure: unknown,
  ): Promise<{ items: ChunkItem[]; embeddings: Awaited<ReturnType<EmbeddingProvider["embedBatch"]>> }> {
    if (items.length === 1) {
      const [culprit] = items;
      const relativePath = this.toRelativePath(culprit);
      const quarantinable = classifyEmbeddingQuarantinable(failure, relativePath);
      if (!quarantinable) throw failure;
      await this.quarantineStore?.markFailed(relativePath, quarantinable);
      this.stats.errors++;
      return { items: [], embeddings: [] };
    }
    if (!classifyEmbeddingQuarantinable(failure, "")) throw failure;
    const mid = Math.ceil(items.length / 2);
    const left = await this.embedOrBisect(items.slice(0, mid));
    const right = await this.embedOrBisect(items.slice(mid));
    return {
      items: [...left.items, ...right.items],
      embeddings: [...left.embeddings, ...right.embeddings],
    };
  }

  /** Embed `items` in one request; on failure, bisect them further. */
  private async embedOrBisect(
    items: ChunkItem[],
  ): Promise<{ items: ChunkItem[]; embeddings: Awaited<ReturnType<EmbeddingProvider["embedBatch"]>> }> {
    try {
      const embeddings = await this.embeddings.embedBatch(items.map((item) => item.chunk.content));
      return { items, embeddings };
    } catch (error) {
      return this.isolateEmbeddingFailures(items, error);
    }
  }

  /** Convert a chunk's absolute filePath to a path relative to its codebase root. */
  private toRelativePath(item: ChunkItem): string {
    const abs = item.chunk.metadata.filePath;
    const base = item.codebasePath;
    return abs.startsWith(base) ? abs.slice(base.length + 1) : abs;
  }

  /**
   * Record a successful Qdrant upsert against the adaptive sizer.
   * If the sizer advances (recovery threshold reached), push the new size
   * into the accumulator and emit a BATCH_SIZE_ADJUSTED log event.
   */
  private onSizerSuccess(): void {
    const before = this.batchSizer.current();
    this.batchSizer.onSuccess();
    const after = this.batchSizer.current();
    if (before !== after) {
      this.accumulator.updateBatchSize(Math.min(after, this.tunedBatchSize));
      pipelineLog.step(LOG_CTX, "BATCH_SIZE_ADJUSTED", {
        from: before,
        to: after,
        reason: "recovery",
      });
    }
  }

  /**
   * Record a failed Qdrant upsert against the adaptive sizer.
   * Only QdrantOptimizationInProgressError causes a size change (halving);
   * other errors are no-ops for the sizer (but still re-thrown by caller).
   * On halving, propagate to accumulator and emit BATCH_SIZE_ADJUSTED.
   */
  private onSizerFailure(error: unknown): void {
    const before = this.batchSizer.current();
    this.batchSizer.onFailure(error);
    const after = this.batchSizer.current();
    if (before !== after) {
      this.accumulator.updateBatchSize(Math.min(after, this.tunedBatchSize));
      pipelineLog.step(LOG_CTX, "BATCH_SIZE_ADJUSTED", {
        from: before,
        to: after,
        reason: "yellow",
      });
    }
  }

  private onBatchComplete(result: BatchResult): void {
    this.stats.batchesProcessed++;
    this.stats.chunksProcessed += result.itemCount;
    if (result.success) {
      const s = this.getStats();
      this.onProgressCb?.(s.itemsProcessed, s.throughput);
    }

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
      if (isDebug()) {
        console.error(`[ChunkPipeline] Batch ${result.batchId} failed: ${result.error}`);
      }
    } else {
      pipelineLog.batchComplete(ctx, result.batchId, result.itemCount, result.durationMs, result.retryCount || 0);
      if (isDebug()) {
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
