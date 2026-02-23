/**
 * BaseIndexingPipeline - Template Method base for indexing pipelines.
 *
 * Provides shared infrastructure: scanner, chunker pool, chunk pipeline,
 * enrichment hooks, flush/shutdown, and enrichment completion.
 * Subclasses compose these building blocks in their own orchestration flow.
 */

import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../adapters/qdrant/client.js";
import { ChunkerPool } from "./chunker/utils/pool.js";
import { pipelineLog } from "./debug-logger.js";
import { ChunkPipeline, DEFAULT_CONFIG } from "./index.js";
import { FileScanner } from "./scanner.js";
import type { Ignore } from "ignore";
import type { ChunkLookupEntry, CodeConfig } from "../../types.js";
import type { EnrichmentModule } from "../enrichment-module.js";

export abstract class BaseIndexingPipeline {
  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly embeddings: EmbeddingProvider,
    protected readonly config: CodeConfig,
    protected readonly enrichment: EnrichmentModule,
  ) {}

  // ── Scanner ──────────────────────────────────────────────

  protected createScanner(overrides?: {
    extensions?: string[];
    customIgnorePatterns?: string[];
  }): FileScanner {
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

  // ── Processing components ────────────────────────────────

  protected createChunkerPool(): ChunkerPool {
    return new ChunkerPool(
      parseInt(process.env.CHUNKER_POOL_SIZE || "4", 10),
      {
        chunkSize: this.config.chunkSize,
        chunkOverlap: this.config.chunkOverlap,
        maxChunkSize: this.config.chunkSize * 2,
      },
    );
  }

  protected createChunkPipeline(collectionName: string): ChunkPipeline {
    return new ChunkPipeline(this.qdrant, this.embeddings, collectionName, {
      workerPool: DEFAULT_CONFIG.workerPool,
      accumulator: DEFAULT_CONFIG.upsertAccumulator,
      enableHybrid: this.config.enableHybridSearch,
    });
  }

  protected setupEnrichmentHooks(
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

  protected async flushAndShutdown(chunkPipeline: ChunkPipeline, chunkerPool: ChunkerPool): Promise<void> {
    await chunkPipeline.flush();
    await Promise.all([chunkPipeline.shutdown(), chunkerPool.shutdown()]);
  }

  /**
   * Starts background enrichment and returns a status getter.
   * Call the returned function after snapshot/finalization to get current status.
   */
  protected startEnrichment(
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
