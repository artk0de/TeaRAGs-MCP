/**
 * IndexingOps — orchestrates first-time index, incremental reindex, and
 * deprecated explicit reindex for IngestFacade.
 *
 * Extracted from IngestFacade to keep the facade thin: indexCodebase
 * branches on collection existence, runs recovery, backfills the
 * indexing marker with modelInfo, and refreshes collection stats. That
 * orchestration lives here; the facade only dispatches.
 */

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { scrollAllPoints } from "../../../adapters/qdrant/scroll.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { computeCollectionStats } from "../../../domains/ingest/collection-stats.js";
import { INDEXING_METADATA_ID } from "../../../domains/ingest/constants.js";
import type { IndexPipeline } from "../../../domains/ingest/indexing.js";
import type { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import {
  invalidateRecoveryCache,
  isRecoveryComplete,
  markRecoveryComplete,
} from "../../../domains/ingest/pipeline/enrichment/recovery-cache.js";
import { parseMarkerPayload } from "../../../domains/ingest/pipeline/indexing-marker-codec.js";
import { StatusModule } from "../../../domains/ingest/pipeline/status-module.js";
import type { ReindexPipeline } from "../../../domains/ingest/reindexing.js";
import { resolveCollectionName, validatePath } from "../../../infra/collection-name.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type {
  ChangeStats,
  IndexOptions,
  IndexStats,
  IndexStatus,
  IngestCodeConfig,
  ProgressCallback,
} from "../../../types.js";

type ModelInfo = { model: string; contextLength: number; dimensions: number };

/** Conservative chars-per-token estimate (2 is safe for both code and prose). */
const CHARS_PER_TOKEN = 2;
/** Safety factor: use 80% of model context to leave room for breadcrumbs/overlap. */
const CONTEXT_SAFETY_FACTOR = 0.8;

export interface IndexingOpsDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  config: IngestCodeConfig;
  indexing: IndexPipeline;
  reindex: ReindexPipeline;
  enrichment: EnrichmentCoordinator;
  snapshotDir: string;
  statsCache?: StatsCache;
  allPayloadSignals?: PayloadSignalDescriptor[];
  reranker?: Reranker;
  gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  modelGuard?: EmbeddingModelGuard;
}

export class IndexingOps {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly config: IngestCodeConfig;
  private readonly indexing: IndexPipeline;
  private readonly reindex: ReindexPipeline;
  private readonly enrichment: EnrichmentCoordinator;
  private readonly snapshotDir: string;
  private readonly statsCache?: StatsCache;
  private readonly allPayloadSignals?: PayloadSignalDescriptor[];
  private readonly reranker?: Reranker;
  private readonly gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly status: StatusModule;

  constructor(deps: IndexingOpsDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.config = deps.config;
    this.indexing = deps.indexing;
    this.reindex = deps.reindex;
    this.enrichment = deps.enrichment;
    this.snapshotDir = deps.snapshotDir;
    this.statsCache = deps.statsCache;
    this.allPayloadSignals = deps.allPayloadSignals;
    this.reranker = deps.reranker;
    this.gitTimePeriods = deps.gitTimePeriods;
    this.modelGuard = deps.modelGuard;
    this.status = new StatusModule(deps.qdrant, deps.snapshotDir);
  }

  /** Index a codebase — first index, force re-index, or incremental fallback. */
  async run(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    if (!options?.forceReindex) {
      const incremental = await this.tryIncrementalIndex(path, progressCallback);
      if (incremental) return incremental;
    }
    return this.fullIndex(path, options, progressCallback);
  }

  /**
   * Deprecated explicit reindex path. Kept for IngestFacade.reindexChanges
   * which forwards here.
   */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    await this.checkEmbeddingHealth();
    const result = await this.reindex.reindexChanges(path, progressCallback);
    await this.refreshStats(path);
    return result;
  }

  /** Indexing status with infrastructure health checks. */
  async getStatus(path: string): Promise<IndexStatus> {
    const [qdrantHealthy, embeddingHealthy] = await Promise.all([
      this.qdrant.checkHealth(),
      this.embeddings.checkHealth(),
    ]);

    const infraHealth: IndexStatus["infraHealth"] = {
      qdrant: { available: qdrantHealthy, url: this.qdrant.url },
      embedding: {
        available: embeddingHealthy,
        provider: this.embeddings.getProviderName(),
        ...(this.embeddings.getBaseUrl ? { url: this.embeddings.getBaseUrl() } : {}),
      },
    };

    if (!qdrantHealthy) {
      return { isIndexed: false, status: "unavailable", infraHealth };
    }

    const status = await this.status.getIndexStatus(path);
    return { ...status, infraHealth };
  }

  /** Drop all indexed data for a codebase and invalidate the model-guard cache. */
  async clear(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    this.modelGuard?.invalidate(collectionName);
    return this.status.clearIndex(path);
  }

  /** Recompute collection stats from Qdrant and save to cache. Public for enrichment callback. */
  async refreshStats(path: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      await this.refreshStatsByCollection(collectionName);
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats:", error);
    }
  }

  /** Recompute stats by collection name. Public so enrichment callback can bind to it. */
  async refreshStatsByCollection(collectionName: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      const points = await scrollAllPoints(this.qdrant, collectionName);
      const stats = computeCollectionStats(points, this.allPayloadSignals, this.gitTimePeriods);
      const payloadFieldKeys = [...this.allPayloadSignals.map((d) => d.key), "navigation"];
      this.statsCache.save(collectionName, stats, payloadFieldKeys);
      this.reranker?.invalidateStats();
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats after chunk enrichment:", error);
    }
  }

  /**
   * Compute effective chunkSize based on model context window.
   *
   * - No modelInfo → return config chunkSize unchanged
   * - User didn't set INGEST_CHUNK_SIZE → use model-derived default
   * - User's chunkSize exceeds model max → cap to maxAllowed
   * - Otherwise → keep user's chunkSize
   */
  resolveEffectiveChunkSize(modelInfo: ModelInfo | undefined): number {
    if (!modelInfo) return this.config.chunkSize;

    const maxAllowed = modelInfo.contextLength * CHARS_PER_TOKEN;
    const defaultChunkSize = Math.floor(maxAllowed * CONTEXT_SAFETY_FACTOR);

    if (!this.config.userSetChunkSize) return defaultChunkSize;
    if (this.config.chunkSize > maxAllowed) return maxAllowed;
    return this.config.chunkSize;
  }

  // ---------------------------------------------------------------------------
  // Branches of run()
  // ---------------------------------------------------------------------------

  /**
   * Incremental reindex path when an existing collection is present.
   * Returns IndexStats on success or undefined when the collection is missing
   * (caller falls back to fullIndex).
   */
  private async tryIncrementalIndex(
    path: string,
    progressCallback?: ProgressCallback,
  ): Promise<IndexStats | undefined> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) return undefined;

    // Model guard before health check — guard reads Qdrant (no embed),
    // health check calls embed() which fails with wrong model name.
    await this.modelGuard?.ensureMatch(collectionName);
    await this.checkEmbeddingHealth();

    const modelInfo = await this.resolveOrBackfillModelInfo(collectionName);
    const effectiveChunkSize = this.resolveEffectiveChunkSize(modelInfo);
    const overrides = { chunkSize: effectiveChunkSize, modelInfo };

    this.dispatchRecovery(collectionName, absolutePath);

    const changeStats = await this.reindex.reindexChanges(path, progressCallback, overrides);

    if (changeStats.chunksAdded > 0) {
      invalidateRecoveryCache(this.snapshotDir, collectionName);
    }

    void this.refreshStats(path);
    return toIndexStats(changeStats);
  }

  private async fullIndex(
    path: string,
    options: IndexOptions | undefined,
    progressCallback?: ProgressCallback,
  ): Promise<IndexStats> {
    await this.checkEmbeddingHealth();
    const modelInfo = await this.resolveModelInfo();
    const effectiveChunkSize = this.resolveEffectiveChunkSize(modelInfo);
    const result = await this.indexing.indexCodebase(path, options, progressCallback, {
      chunkSize: effectiveChunkSize,
      modelInfo,
    });
    await this.refreshStats(path);
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async checkEmbeddingHealth(): Promise<void> {
    await this.embeddings.embed("health");
  }

  private async resolveModelInfo(): Promise<ModelInfo | undefined> {
    try {
      return await this.embeddings.resolveModelInfo?.();
    } catch {
      return undefined;
    }
  }

  /**
   * Try existing marker first to skip the Ollama round-trip. Fall back to a
   * live resolve and backfill the marker so subsequent runs are free.
   */
  private async resolveOrBackfillModelInfo(collectionName: string): Promise<ModelInfo | undefined> {
    const fromMarker = await this.readMarkerModelInfo(collectionName);
    if (fromMarker) return fromMarker;
    const live = await this.resolveModelInfo();
    if (live) await this.backfillMarkerModelInfo(collectionName, live);
    return live;
  }

  private async readMarkerModelInfo(collectionName: string): Promise<ModelInfo | undefined> {
    try {
      const point = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
      if (!point?.payload) return undefined;
      const marker = parseMarkerPayload(point.payload);
      return marker.modelInfo;
    } catch {
      return undefined;
    }
  }

  private async backfillMarkerModelInfo(collectionName: string, modelInfo: ModelInfo): Promise<void> {
    try {
      await this.qdrant.setPayload(collectionName, { modelInfo }, { points: [INDEXING_METADATA_ID] });
    } catch {
      // Non-fatal: backfill failure should not block indexing
    }
  }

  private dispatchRecovery(collectionName: string, absolutePath: string): void {
    if (isRecoveryComplete(this.snapshotDir, collectionName)) return;
    void this.enrichment
      .runRecovery(collectionName, absolutePath)
      .then(() => {
        markRecoveryComplete(this.snapshotDir, collectionName);
      })
      .catch(() => {});
  }
}

function toIndexStats(changeStats: ChangeStats): IndexStats {
  return {
    filesScanned: changeStats.filesAdded + changeStats.filesModified + changeStats.filesDeleted,
    filesIndexed: changeStats.filesAdded + changeStats.filesModified,
    chunksCreated: changeStats.chunksAdded,
    durationMs: changeStats.durationMs,
    status: "completed",
    errors: [],
    enrichmentStatus: changeStats.enrichmentStatus,
    enrichmentDurationMs: changeStats.enrichmentDurationMs,
    enrichmentMetrics: changeStats.enrichmentMetrics,
    migrations: changeStats.migrations,
    changeDetails: {
      filesAdded: changeStats.filesAdded,
      filesModified: changeStats.filesModified,
      filesDeleted: changeStats.filesDeleted,
      filesNewlyIgnored: changeStats.filesNewlyIgnored,
      filesNewlyUnignored: changeStats.filesNewlyUnignored,
      chunksAdded: changeStats.chunksAdded,
      chunksDeleted: changeStats.chunksDeleted,
    },
  };
}
