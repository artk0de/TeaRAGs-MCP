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

import type { EmbeddingProvider } from "../adapters/embeddings/base.js";
import type { QdrantManager } from "../adapters/qdrant/client.js";
import { scrollAllPoints } from "../adapters/qdrant/scroll.js";
import { computeCollectionStats } from "../contracts/collection-stats.js";
import { resolveCollectionName, validatePath } from "../contracts/collection.js";
import type { PayloadSignalDescriptor } from "../contracts/types/trajectory.js";
import { createIngestDependencies, type SynchronizerTuning } from "../ingest/factory.js";
import { IndexPipeline } from "../ingest/indexing.js";
import type { PipelineTuning } from "../ingest/pipeline/base.js";
import { EnrichmentCoordinator } from "../ingest/pipeline/enrichment/coordinator.js";
import { StatusModule } from "../ingest/pipeline/status-module.js";
import { ReindexPipeline } from "../ingest/reindexing.js";
import type { DeletionConfig } from "../ingest/sync/deletion-strategy.js";
import type { Reranker } from "../search/reranker.js";
import { GitEnrichmentProvider } from "../trajectory/git/provider.js";
import type {
  ChangeStats,
  IndexOptions,
  IndexStats,
  IndexStatus,
  IngestCodeConfig,
  ProgressCallback,
  TrajectoryIngestConfig,
} from "../types.js";
import type { StatsCache } from "./stats-cache.js";

export class IngestFacade {
  private readonly enrichment: EnrichmentCoordinator;
  private readonly indexing: IndexPipeline;
  private readonly status: StatusModule;
  private readonly reindex: ReindexPipeline;

  constructor(
    private readonly qdrant: QdrantManager,
    embeddings: EmbeddingProvider,
    ingestConfig: IngestCodeConfig,
    trajectoryConfig: TrajectoryIngestConfig,
    private readonly statsCache?: StatsCache,
    private readonly allPayloadSignals?: PayloadSignalDescriptor[],
    private readonly reranker?: Reranker,
    deleteConfig?: DeletionConfig,
    pipelineTuning?: PipelineTuning,
    syncTuning?: SynchronizerTuning,
  ) {
    const snapshotDir = join(homedir(), ".tea-rags-mcp", "snapshots");
    const deps = createIngestDependencies(qdrant, snapshotDir, syncTuning);

    const squashOpts = trajectoryConfig.squashAwareSessions
      ? { squashAwareSessions: true, sessionGapMinutes: trajectoryConfig.sessionGapMinutes ?? 30 }
      : undefined;
    const providers = trajectoryConfig.enableGitMetadata
      ? [new GitEnrichmentProvider(trajectoryConfig.trajectoryGit ?? undefined, squashOpts)]
      : [];
    this.enrichment = new EnrichmentCoordinator(qdrant, providers);
    this.indexing = new IndexPipeline(qdrant, embeddings, ingestConfig, this.enrichment, deps, pipelineTuning);
    this.status = new StatusModule(qdrant);
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

  /** Index a codebase from scratch or force re-index */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    const result = await this.indexing.indexCodebase(path, options, progressCallback);
    await this.refreshStats(path);
    return result;
  }

  /** Incrementally re-index only changed files */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    const result = await this.reindex.reindexChanges(path, progressCallback);
    await this.refreshStats(path);
    return result;
  }

  /** Get indexing status for a codebase */
  async getIndexStatus(path: string): Promise<IndexStatus> {
    return this.status.getIndexStatus(path);
  }

  /** Clear all indexed data for a codebase */
  async clearIndex(path: string): Promise<void> {
    return this.status.clearIndex(path);
  }

  /** Recompute collection stats from Qdrant and save to cache. */
  private async refreshStats(path: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      const points = await scrollAllPoints(this.qdrant, collectionName);
      const stats = computeCollectionStats(points, this.allPayloadSignals);
      this.statsCache.save(collectionName, stats);
      this.reranker?.invalidateStats();
    } catch (error) {
      // Stats refresh failure should not fail the indexing operation
      console.error("[StatsCache] Failed to refresh collection stats:", error);
    }
  }
}
