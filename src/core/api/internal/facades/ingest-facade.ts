/**
 * IngestFacade - Public API for codebase indexing operations.
 *
 * Delegates to:
 * - IndexPipeline: full codebase indexing from scratch
 * - ReindexPipeline: incremental re-indexing of changed files
 * - StatusModule: index status queries and cleanup
 * - EnrichmentCoordinator: background trajectory metadata enrichment
 *
 * Post-index: recomputes collection stats and saves to cache.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { scrollAllPoints } from "../../../adapters/qdrant/scroll.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { computeCollectionStats } from "../../../domains/ingest/collection-stats.js";
import { INDEXING_METADATA_ID } from "../../../domains/ingest/constants.js";
import { createIngestDependencies, type SynchronizerTuning } from "../../../domains/ingest/factory.js";
import { IndexPipeline } from "../../../domains/ingest/indexing.js";
import type { PipelineTuning } from "../../../domains/ingest/pipeline/base.js";
import { EnrichmentApplier } from "../../../domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import {
  invalidateRecoveryCache,
  isRecoveryComplete,
  markRecoveryComplete,
} from "../../../domains/ingest/pipeline/enrichment/recovery-cache.js";
import { EnrichmentRecovery } from "../../../domains/ingest/pipeline/enrichment/recovery.js";
import { parseMarkerPayload } from "../../../domains/ingest/pipeline/indexing-marker-codec.js";
import { StatusModule } from "../../../domains/ingest/pipeline/status-module.js";
import { ReindexPipeline } from "../../../domains/ingest/reindexing.js";
import type { DeletionConfig } from "../../../domains/ingest/sync/deletion-strategy.js";
import { GitEnrichmentProvider } from "../../../domains/trajectory/git/provider.js";
import { StaticPayloadBuilder } from "../../../domains/trajectory/static/provider.js";
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
  TrajectoryIngestConfig,
} from "../../../types.js";

/** Model info resolved from embedding provider (e.g. Ollama /api/show) */
type ModelInfo = { model: string; contextLength: number; dimensions: number };

/** Conservative chars-per-token estimate (2 is safe for both code and prose) */
const CHARS_PER_TOKEN = 2;
/** Safety factor: use 80% of model context to leave room for breadcrumbs/overlap */
const CONTEXT_SAFETY_FACTOR = 0.8;

export interface IngestFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  config: IngestCodeConfig;
  trajectoryConfig: TrajectoryIngestConfig;
  statsCache?: StatsCache;
  allPayloadSignals?: PayloadSignalDescriptor[];
  reranker?: Reranker;
  deleteConfig?: DeletionConfig;
  pipelineTuning?: PipelineTuning;
  syncTuning?: SynchronizerTuning;
  snapshotDir?: string;
  modelGuard?: EmbeddingModelGuard;
}

export class IngestFacade {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly config: IngestCodeConfig;
  private readonly statsCache?: StatsCache;
  private readonly allPayloadSignals?: PayloadSignalDescriptor[];
  private readonly reranker?: Reranker;
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly enrichment: EnrichmentCoordinator;
  private readonly indexing: IndexPipeline;
  private readonly status: StatusModule;
  private readonly reindex: ReindexPipeline;
  private readonly gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  private readonly snapshotDir: string;

  constructor(deps: IngestFacadeDeps) {
    const {
      qdrant,
      embeddings,
      config,
      trajectoryConfig,
      statsCache,
      allPayloadSignals,
      reranker,
      deleteConfig,
      pipelineTuning,
      syncTuning,
      snapshotDir,
      modelGuard,
    } = deps;
    this.qdrant = qdrant;
    this.embeddings = embeddings;
    this.config = config;
    this.statsCache = statsCache;
    this.allPayloadSignals = allPayloadSignals;
    this.reranker = reranker;
    this.modelGuard = modelGuard;
    /* v8 ignore next 2 -- fallback for backward compat */
    this.snapshotDir = snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
    const resolvedSnapshotDir = this.snapshotDir;

    const squashOpts = trajectoryConfig.squashAwareSessions
      ? { squashAwareSessions: true, sessionGapMinutes: trajectoryConfig.sessionGapMinutes ?? 30 }
      : undefined;
    const providers = trajectoryConfig.enableGitMetadata
      ? [new GitEnrichmentProvider(trajectoryConfig.trajectoryGit ?? undefined, squashOpts)]
      : [];
    const enrichmentProviderKey = providers.length > 0 ? providers[0].key : undefined;

    const ingestDeps = createIngestDependencies(
      qdrant,
      resolvedSnapshotDir,
      new StaticPayloadBuilder(),
      syncTuning,
      this.config.enableHybridSearch,
      enrichmentProviderKey,
    );
    if (trajectoryConfig.trajectoryGit) {
      this.gitTimePeriods = {
        fileMonths: trajectoryConfig.trajectoryGit.logMaxAgeMonths,
        chunkMonths: trajectoryConfig.trajectoryGit.chunkMaxAgeMonths,
      };
    }
    const recovery = providers.length > 0 ? new EnrichmentRecovery(qdrant, new EnrichmentApplier(qdrant)) : undefined;
    this.enrichment = new EnrichmentCoordinator(qdrant, providers, recovery);
    this.enrichment.onChunkEnrichmentComplete = async (collectionName) => {
      // Fire-and-forget: don't block enrichment completion with full collection scroll
      void this.refreshStatsByCollection(collectionName);
    };
    this.indexing = new IndexPipeline(qdrant, embeddings, this.config, this.enrichment, ingestDeps, pipelineTuning);
    this.status = new StatusModule(qdrant, resolvedSnapshotDir);
    this.reindex = new ReindexPipeline(
      qdrant,
      embeddings,
      this.config,
      this.enrichment,
      ingestDeps,
      deleteConfig,
      pipelineTuning,
    );
  }

  /** Verify embedding provider is reachable before starting work. */
  private async checkEmbeddingHealth(): Promise<void> {
    await this.embeddings.embed("health");
  }

  /** Resolve model capabilities from the embedding provider, if supported. */
  private async resolveModelInfo(): Promise<ModelInfo | undefined> {
    try {
      return await this.embeddings.resolveModelInfo?.();
    } catch {
      return undefined;
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

  /** Index a codebase — first index, force re-index, or incremental fallback */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    if (!options?.forceReindex) {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      const exists = await this.qdrant.collectionExists(collectionName);
      if (exists) {
        // Model guard before health check — guard reads Qdrant (no embed),
        // health check calls embed() which fails with wrong model name
        await this.modelGuard?.ensureMatch(collectionName);
        await this.checkEmbeddingHealth();

        // Try reading modelInfo from existing marker to avoid Ollama query
        let modelInfo = await this.readMarkerModelInfo(collectionName);
        if (!modelInfo) {
          // Legacy collection or marker without modelInfo — query Ollama
          modelInfo = await this.resolveModelInfo();
          if (modelInfo) {
            await this.backfillMarkerModelInfo(collectionName, modelInfo);
          }
        }
        const effectiveChunkSize = this.resolveEffectiveChunkSize(modelInfo);
        const overrides = { chunkSize: effectiveChunkSize, modelInfo };

        // Recovery: local file guard (0ms) + fire-and-forget (background)
        if (!isRecoveryComplete(this.snapshotDir, collectionName)) {
          void this.enrichment
            .runRecovery(collectionName, absolutePath)
            .then(() => {
              markRecoveryComplete(this.snapshotDir, collectionName);
            })
            .catch(() => {});
        }

        const changeStats = await this.reindex.reindexChanges(path, progressCallback, overrides);

        // Invalidate recovery cache when new chunks are added (may need enrichment)
        if (changeStats.chunksAdded > 0) {
          invalidateRecoveryCache(this.snapshotDir, collectionName);
        }

        // Fire-and-forget: stats refresh scrolls the entire collection
        void this.refreshStats(path);
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
    }

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

  /** @deprecated Use indexCodebase — it auto-detects incremental reindex */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    await this.checkEmbeddingHealth();
    const result = await this.reindex.reindexChanges(path, progressCallback);
    await this.refreshStats(path);
    return result;
  }

  /** Get indexing status with infrastructure health checks. */
  async getIndexStatus(path: string): Promise<IndexStatus> {
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

  /** Clear all indexed data for a codebase */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    this.modelGuard?.invalidate(collectionName);
    return this.status.clearIndex(path);
  }

  /** Read modelInfo from an existing indexing marker. Returns undefined if marker is missing or has no modelInfo. */
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

  /** Backfill modelInfo into an existing marker (legacy collections). */
  private async backfillMarkerModelInfo(collectionName: string, modelInfo: ModelInfo): Promise<void> {
    try {
      await this.qdrant.setPayload(collectionName, { modelInfo }, { points: [INDEXING_METADATA_ID] });
    } catch {
      // Non-fatal: backfill failure should not block indexing
    }
  }

  /** Recompute collection stats from Qdrant and save to cache. */
  private async refreshStats(path: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      await this.refreshStatsByCollection(collectionName);
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats:", error);
    }
  }

  /** Recompute stats by collection name (used by enrichment callback). */
  private async refreshStatsByCollection(collectionName: string): Promise<void> {
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
}
