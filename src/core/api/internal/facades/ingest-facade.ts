/**
 * IngestFacade — thin dispatcher for codebase indexing operations.
 *
 * Wires domain modules (IndexPipeline, ReindexPipeline, StatusModule,
 * EnrichmentCoordinator) and delegates orchestration to IndexingOps.
 * Stays in the facade: status lookup, clearIndex, wiring of the
 * enrichment completion callback.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { createIngestDependencies, type SynchronizerTuning } from "../../../domains/ingest/factory.js";
import { IndexPipeline } from "../../../domains/ingest/indexing.js";
import type { PipelineTuning } from "../../../domains/ingest/pipeline/base.js";
import { EnrichmentApplier } from "../../../domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import { EnrichmentRecovery } from "../../../domains/ingest/pipeline/enrichment/recovery.js";
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
import { IndexingOps } from "../ops/indexing-ops.js";

type ModelInfo = { model: string; contextLength: number; dimensions: number };

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
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly status: StatusModule;
  private readonly indexingOps: IndexingOps;

  constructor(deps: IngestFacadeDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.modelGuard = deps.modelGuard;

    /* v8 ignore next 2 -- fallback for backward compat */
    const snapshotDir =
      deps.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");

    const { enrichment, indexing, reindex, gitTimePeriods } = this.buildIngestPipeline(deps, snapshotDir);
    this.status = new StatusModule(deps.qdrant, snapshotDir);
    this.indexingOps = new IndexingOps({
      qdrant: deps.qdrant,
      embeddings: deps.embeddings,
      config: deps.config,
      indexing,
      reindex,
      enrichment,
      snapshotDir,
      statsCache: deps.statsCache,
      allPayloadSignals: deps.allPayloadSignals,
      reranker: deps.reranker,
      gitTimePeriods,
      modelGuard: deps.modelGuard,
    });

    // Fire-and-forget stats refresh when chunk enrichment finishes.
    enrichment.onChunkEnrichmentComplete = async (collectionName) => {
      void this.indexingOps.refreshStatsByCollection(collectionName);
    };
  }

  /** Index a codebase — first index, force re-index, or incremental fallback. */
  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    return this.indexingOps.run(path, options, progressCallback);
  }

  /** @deprecated Use indexCodebase — it auto-detects incremental reindex */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    return this.indexingOps.reindexChanges(path, progressCallback);
  }

  /** Exposed for tests + MCP consumers; computed from embedding model context window. */
  resolveEffectiveChunkSize(modelInfo: ModelInfo | undefined): number {
    return this.indexingOps.resolveEffectiveChunkSize(modelInfo);
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

  /**
   * Assemble the ingest pipeline — trajectory enrichment providers, the
   * coordinator that drives them, and the two pipelines (full + incremental)
   * that share the coordinator.
   */
  private buildIngestPipeline(
    deps: IngestFacadeDeps,
    snapshotDir: string,
  ): {
    enrichment: EnrichmentCoordinator;
    indexing: IndexPipeline;
    reindex: ReindexPipeline;
    gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  } {
    const { qdrant, embeddings, config, trajectoryConfig, deleteConfig, pipelineTuning, syncTuning } = deps;

    const squashOpts = trajectoryConfig.squashAwareSessions
      ? { squashAwareSessions: true, sessionGapMinutes: trajectoryConfig.sessionGapMinutes ?? 30 }
      : undefined;
    const providers = trajectoryConfig.enableGitMetadata
      ? [new GitEnrichmentProvider(trajectoryConfig.trajectoryGit ?? undefined, squashOpts)]
      : [];
    const enrichmentProviderKey = providers.length > 0 ? providers[0].key : undefined;

    const ingestDeps = createIngestDependencies(
      qdrant,
      snapshotDir,
      new StaticPayloadBuilder(),
      syncTuning,
      config.enableHybridSearch,
      enrichmentProviderKey,
    );

    const gitTimePeriods = trajectoryConfig.trajectoryGit
      ? {
          fileMonths: trajectoryConfig.trajectoryGit.logMaxAgeMonths,
          chunkMonths: trajectoryConfig.trajectoryGit.chunkMaxAgeMonths,
        }
      : undefined;

    const recovery = providers.length > 0 ? new EnrichmentRecovery(qdrant, new EnrichmentApplier(qdrant)) : undefined;
    const enrichment = new EnrichmentCoordinator(qdrant, providers, recovery);
    const indexing = new IndexPipeline(qdrant, embeddings, config, enrichment, ingestDeps, pipelineTuning);
    const reindex = new ReindexPipeline(
      qdrant,
      embeddings,
      config,
      enrichment,
      ingestDeps,
      deleteConfig,
      pipelineTuning,
    );

    return { enrichment, indexing, reindex, gitTimePeriods };
  }
}
