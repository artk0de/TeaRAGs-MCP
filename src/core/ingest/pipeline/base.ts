/**
 * BaseIndexingPipeline - Template Method base for indexing pipelines.
 *
 * Provides shared infrastructure: scanner, chunker pool, chunk pipeline,
 * enrichment hooks, flush/shutdown, and enrichment completion.
 * Subclasses compose these building blocks in their own orchestration flow.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { Ignore } from "ignore";

import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { resolveCollectionName, validatePath } from "../../api/shared.js";
import type { ChunkLookupEntry, CodeConfig } from "../../types.js";
import type { IngestDependencies } from "../factory.js";
import type { EnrichmentModule } from "../trajectory/enrichment-module.js";
import { ChunkerPool } from "./chunker/utils/pool.js";
import { pipelineLog } from "./debug-logger.js";
import { ChunkPipeline, DEFAULT_CONFIG } from "./index.js";
import { FileScanner } from "./scanner.js";

export interface ProcessingContext {
  chunkerPool: ChunkerPool;
  chunkPipeline: ChunkPipeline;
}

export abstract class BaseIndexingPipeline {
  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly embeddings: EmbeddingProvider,
    protected readonly config: CodeConfig,
    protected readonly enrichment: EnrichmentModule,
    protected readonly deps: IngestDependencies,
  ) {}

  // ── Shared context ─────────────────────────────────────────

  protected get snapshotDir(): string {
    return join(homedir(), ".tea-rags-mcp", "snapshots");
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

  protected initProcessing(collectionName: string, absolutePath: string, scanner: FileScanner): ProcessingContext {
    const chunkerPool = this.createChunkerPool();
    const chunkPipeline = this.createChunkPipeline(collectionName);
    this.setupEnrichmentHooks(chunkPipeline, absolutePath, collectionName, scanner.getIgnoreFilter());
    chunkPipeline.start();
    return { chunkerPool, chunkPipeline };
  }

  protected async finalizeProcessing(
    ctx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    collectionName: string,
    absolutePath: string,
  ): Promise<() => "completed" | "background" | "skipped"> {
    await this.flushAndShutdown(ctx.chunkPipeline, ctx.chunkerPool);
    return this.startEnrichment(chunkMap, collectionName, absolutePath);
  }

  // ── Processing components (private) ────────────────────

  private createChunkerPool(): ChunkerPool {
    return new ChunkerPool(parseInt(process.env.CHUNKER_POOL_SIZE || "4", 10), {
      chunkSize: this.config.chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      maxChunkSize: this.config.chunkSize * 2,
    });
  }

  private createChunkPipeline(collectionName: string): ChunkPipeline {
    return new ChunkPipeline(this.qdrant, this.embeddings, collectionName, {
      workerPool: DEFAULT_CONFIG.workerPool,
      accumulator: DEFAULT_CONFIG.upsertAccumulator,
      enableHybrid: this.config.enableHybridSearch,
    });
  }

  private setupEnrichmentHooks(
    chunkPipeline: ChunkPipeline,
    absolutePath: string,
    collectionName: string,
    ignoreFilter: Ignore,
  ): void {
    if (this.config.enableGitMetadata) {
      this.enrichment.prefetchGitLog(absolutePath, collectionName, ignoreFilter);
      chunkPipeline.setOnBatchUpserted((items) => {
        this.enrichment.onChunksStored(collectionName, absolutePath, items);
      });
    }
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
  ): () => "completed" | "background" | "skipped" {
    if (!this.config.enableGitMetadata) return () => "skipped";
    if (chunkMap.size === 0) return () => "skipped";

    let done = false;
    this.enrichment.startChunkChurn(collectionName, absolutePath, chunkMap);
    this.enrichment
      .awaitCompletion(collectionName)
      .then(() => {
        done = true;
      })
      .catch((error) => {
        console.error("[Pipeline] Background enrichment failed:", error);
      });

    return () => (done ? "completed" : "background");
  }
}
