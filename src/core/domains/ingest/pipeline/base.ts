/**
 * BaseIndexingPipeline - Template Method base for indexing pipelines.
 *
 * Provides shared infrastructure: scanner, chunker pool, chunk pipeline,
 * enrichment hooks, flush/shutdown, and enrichment completion.
 * Subclasses compose these building blocks in their own orchestration flow.
 */

import type { Ignore } from "ignore";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { ChunkLookupEntry, EnrichmentMetrics, IngestCodeConfig } from "../../../types.js";
import type { IngestDependencies } from "../factory.js";
import { ChunkerPool } from "./chunker/infra/pool.js";
import type { EnrichmentCoordinator } from "./enrichment/coordinator.js";
import { ChunkPipeline } from "./index.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { FileScanner } from "./scanner.js";
import type { PipelineConfig } from "./types.js";

export interface ProcessingContext {
  chunkerPool: ChunkerPool;
  chunkPipeline: ChunkPipeline;
}

export interface EnrichmentStatusResult {
  status: "completed" | "background" | "skipped";
  metrics?: EnrichmentMetrics;
}

export interface PipelineTuning {
  pipelineConfig: PipelineConfig;
  chunkerPoolSize: number;
  fileConcurrency: number;
}

/** Fallback tuning when no config is injected (tests, legacy callers) */
const DEFAULT_TUNING: PipelineTuning = {
  pipelineConfig: {
    workerPool: { concurrency: 1, maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 5000 },
    deleteWorkerPool: { concurrency: 8, maxRetries: 3, retryBaseDelayMs: 100, retryMaxDelayMs: 5000 },
    upsertAccumulator: { batchSize: 1024, flushTimeoutMs: 2000, maxQueueSize: 2 },
    deleteAccumulator: { batchSize: 500, flushTimeoutMs: 1000, maxQueueSize: 16 },
  },
  chunkerPoolSize: 4,
  fileConcurrency: 50,
};

export abstract class BaseIndexingPipeline {
  protected readonly tuning: PipelineTuning;

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly embeddings: EmbeddingProvider,
    protected readonly config: IngestCodeConfig,
    protected readonly enrichment: EnrichmentCoordinator,
    protected readonly deps: IngestDependencies,
    tuning?: PipelineTuning,
  ) {
    this.tuning = tuning ?? DEFAULT_TUNING;
  }

  // ── Shared context ─────────────────────────────────────────

  protected get snapshotDir(): string {
    return this.deps.snapshotDir;
  }

  protected async resolveContext(path: string): Promise<{
    absolutePath: string;
    collectionName: string;
  }> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    return { absolutePath, collectionName };
  }

  // ── Scanner ──────────────────────────────────────────────

  protected createScanner(overrides?: { extensions?: string[]; customIgnorePatterns?: string[] }): FileScanner {
    return new FileScanner({
      supportedExtensions: overrides?.extensions || this.config.supportedExtensions,
      ignorePatterns: this.config.ignorePatterns,
      customIgnorePatterns: overrides?.customIgnorePatterns || this.config.customIgnorePatterns,
    });
  }

  protected async scanFiles(absolutePath: string, scanner: FileScanner): Promise<string[]> {
    await scanner.loadIgnorePatterns(absolutePath);
    pipelineLog.resetProfiler();
    pipelineLog.stageStart("scan");
    const files = await scanner.scanDirectory(absolutePath);
    pipelineLog.stageEnd("scan");
    return files;
  }

  // ── Processing lifecycle ─────────────────────────────────

  protected initProcessing(
    collectionName: string,
    absolutePath: string,
    scanner: FileScanner,
    changedPaths?: string[],
  ): ProcessingContext {
    const chunkerPool = this.createChunkerPool();
    const chunkPipeline = this.createChunkPipeline(collectionName);
    this.setupEnrichmentHooks(chunkPipeline, absolutePath, collectionName, scanner.getIgnoreFilter(), changedPaths);
    chunkPipeline.start();
    return { chunkerPool, chunkPipeline };
  }

  protected async finalizeProcessing(
    ctx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    collectionName: string,
    absolutePath: string,
  ): Promise<() => EnrichmentStatusResult> {
    await this.flushAndShutdown(ctx.chunkPipeline, ctx.chunkerPool);
    return this.startEnrichment(chunkMap, collectionName, absolutePath);
  }

  // ── Processing components (private) ────────────────────

  private createChunkerPool(): ChunkerPool {
    return new ChunkerPool(this.tuning.chunkerPoolSize, {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      maxChunkSize: this.config.chunkSize * 2,
    });
  }

  private createChunkPipeline(collectionName: string): ChunkPipeline {
    return new ChunkPipeline(this.qdrant, this.embeddings, collectionName, this.deps.payloadBuilder, {
      workerPool: this.tuning.pipelineConfig.workerPool,
      accumulator: this.tuning.pipelineConfig.upsertAccumulator,
      enableHybrid: this.config.enableHybridSearch,
    });
  }

  private setupEnrichmentHooks(
    chunkPipeline: ChunkPipeline,
    absolutePath: string,
    collectionName: string,
    ignoreFilter: Ignore,
    changedPaths?: string[],
  ): void {
    this.enrichment.prefetch(absolutePath, collectionName, ignoreFilter, changedPaths);
    chunkPipeline.setOnBatchUpserted((items) => {
      this.enrichment.onChunksStored(collectionName, absolutePath, items);
    });
  }

  // ── Teardown ─────────────────────────────────────────────

  private async flushAndShutdown(chunkPipeline: ChunkPipeline, chunkerPool: ChunkerPool): Promise<void> {
    await chunkPipeline.flush();
    await Promise.all([chunkPipeline.shutdown(), chunkerPool.shutdown()]);
  }

  /**
   * Starts background enrichment and returns a status getter.
   * Call the returned function after snapshot/finalization to get current status.
   */
  private startEnrichment(
    chunkMap: Map<string, ChunkLookupEntry[]>,
    collectionName: string,
    absolutePath: string,
  ): () => EnrichmentStatusResult {
    if (chunkMap.size === 0) {
      // Prefetch may have set marker to "in_progress" — clear it
      this.enrichment.updateEnrichmentMarker(collectionName, { status: "completed" }).catch(() => {});
      return () => ({ status: "skipped" });
    }

    let done = false;
    let enrichmentMetrics: EnrichmentMetrics | undefined;
    this.enrichment.startChunkEnrichment(collectionName, absolutePath, chunkMap);
    this.enrichment
      .awaitCompletion(collectionName)
      .then((m) => {
        done = true;
        enrichmentMetrics = m;
      })
      .catch((error) => {
        console.error("[Pipeline] Background enrichment failed:", error);
      });

    return () => ({ status: done ? "completed" : "background", metrics: enrichmentMetrics });
  }
}
