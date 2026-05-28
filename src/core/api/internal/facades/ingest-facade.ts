/**
 * IngestFacade — public delegation surface for codebase indexing.
 *
 * The facade does two things: wire the ingest pipeline at construction
 * time, then delegate every public method to IndexingOps. All pipeline
 * work (index / reindex branching, status queries, clearIndex, stats
 * refresh) lives in IndexingOps.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EnrichmentProvider } from "../../../contracts/types/provider.js";
import type { StatsAccumulatorDescriptor } from "../../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { createIngestDependencies, type SynchronizerTuning } from "../../../domains/ingest/factory.js";
import { IndexPipeline } from "../../../domains/ingest/operations/indexing.js";
import { ReindexPipeline } from "../../../domains/ingest/operations/reindexing.js";
import type { PipelineRegistryDeps, PipelineTuning } from "../../../domains/ingest/pipeline/base.js";
import { EnrichmentApplier } from "../../../domains/ingest/pipeline/enrichment/applier.js";
import { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../domains/ingest/pipeline/enrichment/executor/index.js";
import { EnrichmentRecovery } from "../../../domains/ingest/pipeline/enrichment/recovery.js";
import type { DeletionConfig } from "../../../domains/ingest/sync/deletion/strategy.js";
import { StaticPayloadBuilder } from "../../../domains/trajectory/static/provider.js";
import type { EmbeddingModelGuard } from "../../../infra/embedding-model-guard.js";
import type { CollectionRegistry } from "../../../infra/registry/collection-registry.js";
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
  statsAccumulators?: readonly StatsAccumulatorDescriptor[];
  reranker?: Reranker;
  deleteConfig?: DeletionConfig;
  pipelineTuning?: PipelineTuning;
  syncTuning?: SynchronizerTuning;
  snapshotDir?: string;
  modelGuard?: EmbeddingModelGuard;
  collectionRegistry?: CollectionRegistry;
  teaRagsVersion?: string;
  /**
   * Full enrichment provider list passed verbatim to EnrichmentCoordinator
   * — single source of truth, owned by the caller (bootstrap). Bootstrap
   * builds this list from `composition.registry.getAllEnrichmentProviders()`
   * and applies config-driven filters (e.g. drops the git provider when
   * `trajectoryConfig.enableGitMetadata` is false). Order matters only for
   * prefetch start time, not for marker-store keying (keys are per provider).
   * Defaults to empty when omitted — IngestFacade does not synthesize
   * providers inline.
   */
  enrichmentProviders?: EnrichmentProvider[];
  /**
   * Per-collection DuckDB pool — present when codegraph is wired.
   * `IndexingOps.clear` / force-reindex paths use it to drop the
   * per-collection DuckDB file alongside the Qdrant collection. Omitted
   * when codegraph is disabled.
   */
  codegraphPool?: GraphDbClientPool;
}

export class IngestFacade {
  private readonly indexingOps: IndexingOps;

  constructor(deps: IngestFacadeDeps) {
    /* v8 ignore next 2 -- fallback for backward compat */
    const snapshotDir =
      deps.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");

    const { enrichment, indexing, reindex, gitTimePeriods } = this.buildIngestPipeline(deps, snapshotDir);
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
      statsAccumulators: deps.statsAccumulators,
      reranker: deps.reranker,
      gitTimePeriods,
      modelGuard: deps.modelGuard,
      codegraphPool: deps.codegraphPool,
    });

    // Stats refresh when chunk enrichment finishes. Awaited so the
    // coordinator's allSettled-then chain (itself fire-and-forget) only
    // resolves after the cache is updated — keeps callback semantics
    // observable for tests and ordered for any downstream chain.
    enrichment.onChunkEnrichmentComplete = async (collectionName) => {
      await this.indexingOps.refreshStatsByCollection(collectionName);
    };
  }

  async indexCodebase(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    return this.indexingOps.run(path, options, progressCallback);
  }

  /** @deprecated Use indexCodebase — it auto-detects incremental reindex */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    return this.indexingOps.reindexChanges(path, progressCallback);
  }

  resolveEffectiveChunkSize(modelInfo: ModelInfo | undefined): number {
    return this.indexingOps.resolveEffectiveChunkSize(modelInfo);
  }

  async getIndexStatus(path: string): Promise<IndexStatus> {
    return this.indexingOps.getStatus(path);
  }

  async clearIndex(path: string): Promise<void> {
    return this.indexingOps.clear(path);
  }

  /**
   * Assemble the ingest pipeline — trajectory enrichment providers, the
   * coordinator that drives them, and the two pipelines (full + incremental)
   * that share the coordinator. Synchronous helper; no pipeline logic.
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

    // Providers come from the TrajectoryRegistry via bootstrap (no inline
    // construction here). `trajectoryConfig.enableGitMetadata` filtering
    // already happened upstream — IngestFacade trusts the list as-is.
    const providers: EnrichmentProvider[] = deps.enrichmentProviders ?? [];
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

    // Single shared executor — Coordinator and Recovery dispatch through the
    // same seam. Phase-2 of the worker-pool spec swaps this for a
    // ThreadPool-backed impl without touching the phases or recovery.
    const enrichmentExecutor = new InlineEnrichmentExecutor();
    const recovery =
      providers.length > 0
        ? new EnrichmentRecovery(qdrant, new EnrichmentApplier(qdrant), { executor: enrichmentExecutor })
        : undefined;
    const enrichment = new EnrichmentCoordinator(qdrant, providers, recovery, enrichmentExecutor);
    const registryDeps: PipelineRegistryDeps = {
      registry: deps.collectionRegistry,
      teaRagsVersion: deps.teaRagsVersion,
    };
    const indexing = new IndexPipeline(
      qdrant,
      embeddings,
      config,
      enrichment,
      ingestDeps,
      pipelineTuning,
      registryDeps,
    );
    const reindex = new ReindexPipeline(
      qdrant,
      embeddings,
      config,
      enrichment,
      ingestDeps,
      deleteConfig,
      pipelineTuning,
      registryDeps,
    );

    return { enrichment, indexing, reindex, gitTimePeriods };
  }
}
