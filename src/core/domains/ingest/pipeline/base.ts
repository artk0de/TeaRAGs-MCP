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
import { TeaRagsError } from "../../../infra/errors.js";
import type { CollectionRegistry } from "../../../infra/registry/collection-registry.js";
import type { ChunkLookupEntry, EnrichmentMetrics, IngestCodeConfig } from "../../../types.js";
import type { IngestDependencies } from "../factory.js";
import type { CodegraphDbLister, CodegraphDbRemover } from "../infra/alias-cleanup.js";
import { ChunkerPool } from "./chunker/infra/pool.js";
import type { EnrichmentCoordinator } from "./enrichment/coordinator.js";
import { ChunkPipeline } from "./index.js";
import { updateHeartbeat } from "./indexing-marker.js";
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

/** Heartbeat interval: how often (ms) to update lastHeartbeat in the indexing marker */
const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

/** Optional collaborators wired by the facade — kept out of the long positional list. */
export interface PipelineRegistryDeps {
  registry?: CollectionRegistry;
  teaRagsVersion?: string;
  /**
   * Deletes the per-version codegraph DuckDB file for an orphan collection
   * during alias cleanup. Wired from the codegraph pool by the facade; omitted
   * when codegraph is disabled. Without it the per-version DuckDB files leak.
   */
  codegraphRemover?: CodegraphDbRemover;
  /**
   * Enumerates the on-disk versioned codegraph DBs for a base collection. Wired
   * from the codegraph pool by the facade; omitted when codegraph is disabled.
   * Drives the ancient-orphan sweep (`sweepCodegraphOrphans`) that reclaims
   * `<base>_v<N>.duckdb` files whose Qdrant collection is already gone.
   */
  codegraphLister?: CodegraphDbLister;
}

export abstract class BaseIndexingPipeline {
  protected readonly tuning: PipelineTuning;
  protected readonly registry: CollectionRegistry | undefined;
  protected readonly teaRagsVersion: string;
  protected readonly codegraphRemover: CodegraphDbRemover | undefined;
  protected readonly codegraphLister: CodegraphDbLister | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    protected readonly qdrant: QdrantManager,
    protected readonly embeddings: EmbeddingProvider,
    protected readonly config: IngestCodeConfig,
    protected readonly enrichment: EnrichmentCoordinator,
    protected readonly deps: IngestDependencies,
    tuning?: PipelineTuning,
    registryDeps?: PipelineRegistryDeps,
  ) {
    this.tuning = tuning ?? DEFAULT_TUNING;
    this.registry = registryDeps?.registry;
    this.teaRagsVersion = registryDeps?.teaRagsVersion ?? "0.0.0";
    this.codegraphRemover = registryDeps?.codegraphRemover;
    this.codegraphLister = registryDeps?.codegraphLister;
  }

  /**
   * Start periodic heartbeat updates for a collection's indexing marker.
   * Signals to `getIndexStatus` that the indexing process is still alive.
   */
  protected startHeartbeat(collectionName: string): void {
    this.stopHeartbeat();
    // Fire immediately, then repeat on interval
    void updateHeartbeat(this.qdrant, collectionName);
    this.heartbeatTimer = setInterval(
      /* v8 ignore next -- interval callback: same as immediate call above, untestable without real timer */
      () => void updateHeartbeat(this.qdrant, collectionName),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  /** Stop periodic heartbeat updates. */
  protected stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** Re-throw typed errors as-is; wrap unknown errors in the given class. */
  protected wrapUnexpectedError(
    error: unknown,
    ErrorClass: new (message: string, cause?: Error) => TeaRagsError,
  ): never {
    if (error instanceof TeaRagsError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ErrorClass(message, error instanceof Error ? error : undefined);
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
    chunkSizeOverride?: number,
  ): ProcessingContext {
    const chunkerPool = this.createChunkerPool(chunkSizeOverride);
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

  /**
   * Persist a project-registry entry for the freshly indexed collection.
   * Failure is logged to stderr but never aborts the indexing run — the
   * registry is an out-of-band catalogue, not part of the index transaction.
   *
   * MUST be called with the canonical (alias) name, not the versioned target.
   * countPoints transparently resolves the alias to its current collection.
   */
  protected async recordRegistryEntry(collectionName: string, absolutePath: string): Promise<void> {
    if (!this.registry) return;
    try {
      const chunksCount = await this.qdrant.countPoints(collectionName);
      // Capture embedding endpoints live — symmetric with qdrantUrl. The
      // prime CLI digest reads these back so the operator sees the actual
      // remote endpoints the project was indexed against, not the current
      // shell's env defaults. Omit fields the provider does not expose
      // (ONNX returns undefined for both; Ollama without
      // EMBEDDING_FALLBACK_URL returns undefined for the fallback).
      // Persist CONFIGURED primary URL (getPrimaryBaseUrl), not the
      // currently-active URL (getBaseUrl) — registry should remember what
      // was wired up, not which endpoint we happened to be on at write time.
      const embeddingBaseUrl = this.embeddings.getPrimaryBaseUrl?.() ?? this.embeddings.getBaseUrl?.();
      const embeddingFallbackUrl = this.embeddings.getFallbackBaseUrl?.();
      this.registry.record({
        collectionName,
        path: absolutePath,
        embeddingModel: this.embeddings.getModel(),
        embeddingDimensions: this.embeddings.getDimensions(),
        qdrantUrl: this.qdrant.url,
        ...(embeddingBaseUrl !== undefined ? { embeddingBaseUrl } : {}),
        ...(embeddingFallbackUrl !== undefined ? { embeddingFallbackUrl } : {}),
        // Codegraph is enabled iff the facade wired its deps (remover omitted
        // when CODEGRAPH_ENABLED is off — see RegistryDeps doc). prime reads
        // this back to re-apply the flag, symmetric with the embedding URLs.
        codegraphEnabled: this.codegraphRemover !== undefined,
        indexedAt: new Date().toISOString(),
        teaRagsVersion: this.teaRagsVersion,
        chunksCount,
      });
    } catch (err) {
      process.stderr.write(`[tea-rags] registry record failed: ${(err as Error).message}\n`);
    }
  }

  // ── Processing components (private) ────────────────────

  private createChunkerPool(chunkSizeOverride?: number): ChunkerPool {
    const chunkSize = chunkSizeOverride ?? this.config.chunkSize;
    return new ChunkerPool(this.tuning.chunkerPoolSize, {
      chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      // Hard cap = chunkSize. The chunker MUST emit chunks <= maxChunkSize so
      // they fit inside the embedding model's context window. Anything wider
      // is split by enforceMaxChunkSize before reaching the pipeline.
      maxChunkSize: chunkSize,
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
    this.enrichment.beginRun(absolutePath, collectionName, ignoreFilter, changedPaths);
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
      // Prefetch may have set marker to "in_progress" — drain through awaitCompletion
      // which writes the final file/chunk markers (status=completed when no work).
      this.enrichment.awaitCompletion(collectionName).catch(() => {});
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
