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
import { createIngestDependencies, type SynchronizerTuning } from "../../../domains/ingest/factory.js";
import { IndexPipeline } from "../../../domains/ingest/indexing.js";
import type { PipelineTuning } from "../../../domains/ingest/pipeline/base.js";
import { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
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

export class IngestFacade {
  private readonly enrichment: EnrichmentCoordinator;
  private readonly indexing: IndexPipeline;
  private readonly status: StatusModule;
  private readonly reindex: ReindexPipeline;
  private readonly gitTimePeriods?: { fileMonths: number; chunkMonths: number };

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    ingestConfig: IngestCodeConfig,
    trajectoryConfig: TrajectoryIngestConfig,
    private readonly statsCache?: StatsCache,
    private readonly allPayloadSignals?: PayloadSignalDescriptor[],
    private readonly reranker?: Reranker,
    deleteConfig?: DeletionConfig,
    pipelineTuning?: PipelineTuning,
    syncTuning?: SynchronizerTuning,
    snapshotDir?: string,
    private readonly modelGuard?: EmbeddingModelGuard,
  ) {
    /* v8 ignore next 2 -- fallback for backward compat */
    const resolvedSnapshotDir =
      snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");
    const deps = createIngestDependencies(
      qdrant,
      resolvedSnapshotDir,
      new StaticPayloadBuilder(),
      syncTuning,
      ingestConfig.enableHybridSearch,
    );

    const squashOpts = trajectoryConfig.squashAwareSessions
      ? { squashAwareSessions: true, sessionGapMinutes: trajectoryConfig.sessionGapMinutes ?? 30 }
      : undefined;
    const providers = trajectoryConfig.enableGitMetadata
      ? [new GitEnrichmentProvider(trajectoryConfig.trajectoryGit ?? undefined, squashOpts)]
      : [];
    if (trajectoryConfig.trajectoryGit) {
      this.gitTimePeriods = {
        fileMonths: trajectoryConfig.trajectoryGit.logMaxAgeMonths,
        chunkMonths: trajectoryConfig.trajectoryGit.chunkMaxAgeMonths,
      };
    }
    this.enrichment = new EnrichmentCoordinator(qdrant, providers);
    this.enrichment.onChunkEnrichmentComplete = async (collectionName) => this.refreshStatsByCollection(collectionName);
    this.indexing = new IndexPipeline(qdrant, embeddings, ingestConfig, this.enrichment, deps, pipelineTuning);
    this.status = new StatusModule(qdrant, resolvedSnapshotDir);
    this.reindex = new ReindexPipeline(
      qdrant,
      embeddings,
      ingestConfig,
      this.enrichment,
      deps,
      deleteConfig,
      pipelineTuning,
    );
  }

  /** Verify embedding provider is reachable before starting work. */
  private async checkEmbeddingHealth(): Promise<void> {
    await this.embeddings.embed("health");
  }

  /** Index a codebase — first index, force re-index, or incremental fallback */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    // Model guard before health check — guard reads Qdrant (no embed),
    // health check calls embed() which fails with wrong model name
    if (!options?.forceReindex) {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      const exists = await this.qdrant.collectionExists(collectionName);
      if (exists) {
        await this.modelGuard?.ensureMatch(collectionName);
      }
    }

    await this.checkEmbeddingHealth();

    // If collection exists and no forceReindex → incremental reindex
    if (!options?.forceReindex) {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      const exists = await this.qdrant.collectionExists(collectionName);
      if (exists) {
        const changeStats = await this.reindex.reindexChanges(path, progressCallback);
        await this.refreshStats(path);
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

    const result = await this.indexing.indexCodebase(path, options, progressCallback);
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

  /** Get indexing status for a codebase */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    await this.checkEmbeddingHealth();
    return this.status.getIndexStatus(path);
  }

  /** Clear all indexed data for a codebase */
  async clearIndex(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    this.modelGuard?.invalidate(collectionName);
    return this.status.clearIndex(path);
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
      const payloadFieldKeys = this.allPayloadSignals.map((d) => d.key);
      this.statsCache.save(collectionName, stats, payloadFieldKeys);
      this.reranker?.invalidateStats();
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats after chunk enrichment:", error);
    }
  }
}
