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
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { selectLanguages } from "../../../contracts/language-selector.js";
import { selectProviderKeys } from "../../../contracts/provider-selector.js";
import type { EnrichmentExecutor, IndexRunDaemonGuard } from "../../../contracts/types/enrichment-executor.js";
import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import type { EnrichmentProvider } from "../../../contracts/types/provider.js";
import type { StatsAccumulatorDescriptor } from "../../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import type { SynchronizerTuning } from "../../../domains/ingest/factory.js";
import { CollectionIndexingLock } from "../../../domains/ingest/infra/index.js";
import { IndexPipeline } from "../../../domains/ingest/operations/indexing.js";
import { ReindexPipeline } from "../../../domains/ingest/operations/reindexing.js";
import type { PipelineRegistryDeps, PipelineTuning } from "../../../domains/ingest/pipeline/base.js";
import { SELECTABLE_LANGUAGES } from "../../../domains/ingest/pipeline/chunker/config.js";
import { EnrichmentApplier } from "../../../domains/ingest/pipeline/enrichment/applier.js";
import type { BlobReaderFactory } from "../../../domains/ingest/pipeline/enrichment/chunk-phase.js";
import { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../domains/ingest/pipeline/enrichment/executor/index.js";
import { EnrichmentRecovery } from "../../../domains/ingest/pipeline/enrichment/recovery.js";
import type { DeletionConfig } from "../../../domains/ingest/sync/deletion/strategy.js";
import type { CollectionFootprintFactory } from "../../../domains/maintenance/footprint/index.js";
import type { CollectionRegistry } from "../../../domains/maintenance/registry/collection-registry.js";
import { StaticPayloadBuilder } from "../../../domains/trajectory/static/provider.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type {
  ChangeStats,
  EnrichmentProgressCallback,
  IndexOptions,
  IndexStats,
  IndexStatus,
  IngestCodeConfig,
  ProgressCallback,
  TrajectoryIngestConfig,
} from "../../../types.js";
import { InvalidParameterError } from "../../errors.js";
import { createPathCollectionResolver, type PathCollectionResolver } from "../collection-resolver.js";
import { createCodegraphPayloadHealRunner } from "../infra/codegraph-payload-heal-runner.js";
import { createIngestDependencies } from "../ingest-dependencies.js";
import { IndexingOps, type IndexDriftConsumptionResetter } from "../ops/indexing-ops.js";
import { WorktreeSeedOps } from "../ops/worktree-seed-ops.js";

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
   * Per-language code versions of this build (bd tea-rags-mcp-frwka), from
   * `createComposition`. Stamped onto the registry entry by the runs that
   * actually rebuild a language layer; omitted → nothing is stamped.
   */
  languageCodeVersions?: ReadonlyMap<string, LanguageCodeVersions>;
  /**
   * Drift report re-armed after every run (bd tea-rags-mcp-p0phi). Forwarded
   * to IndexingOps, which owns the reset points. Omitted → nothing is re-armed.
   */
  driftReporter?: IndexDriftConsumptionResetter;
  /**
   * Full effective env set of this run (canonical keys, code defaults
   * materialized) built by bootstrap via `buildRegistryEnvSnapshot`; persisted
   * verbatim into `CollectionEntry.env` on every successful index (9vpnz).
   */
  envSnapshot?: Record<string, string>;
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
  /**
   * Enrichment dispatch seam (Phase 2 of unified-enrichment-worker-pool plan).
   * When omitted, the facade constructs a default `InlineEnrichmentExecutor`
   * — current behavior preserved for callers that haven't migrated yet
   * (tests, legacy bootstrap paths). When `ingest.tune.enrichmentExecutor`
   * is `"worker"`, bootstrap supplies a `WorkerPoolEnrichmentExecutor`
   * instead and the same coordinator + phases dispatch through it
   * transparently.
   */
  enrichmentExecutor?: EnrichmentExecutor;
  /**
   * Keep-alive guard for the codegraph daemon. Passed to the
   * EnrichmentCoordinator, which holds the daemon alive across chunk-write +
   * enrichment so it cannot idle-die mid-run. Omitted when codegraph is
   * disabled — the coordinator falls back to a no-op guard.
   */
  indexRunDaemonGuard?: IndexRunDaemonGuard;
  /**
   * Run-scoped batch blob reader factory (kc93), built by the composition
   * root from the active VcsGitAdapter (`GIT_ADAPTER`) — the facade never
   * imports a concrete git adapter.
   */
  blobReaderFactory: BlobReaderFactory;
  /**
   * Attempts for the pre-indexing embedding health probe (resilient against
   * event-loop starvation). Forwarded to IndexingOps. Defaults applied there.
   */
  healthCheckRetryAttempts?: number;
  /** Pause between health-probe attempts (ms). Forwarded to IndexingOps. */
  healthCheckRetryDelayMs?: number;
  /**
   * The per-collection footprint the worktree clone copies — lets a first index
   * seed from a registered sibling working tree (bd tea-rags-mcp-k8gac). Seeding
   * is wired only when this, the registry, the stats cache and the payload
   * descriptors are all present; omitted → every first index is an ordinary one.
   */
  footprintFactory?: Pick<CollectionFootprintFactory, "build">;
}

export class IngestFacade {
  private readonly indexingOps: IndexingOps;
  /**
   * Provider keys this slice enriches with — the list `forceEnrichments`
   * selectors are validated against AND the frame this slice's
   * `getIndexStatus` reports enrichment health on (bd tea-rags-mcp-x2u65). It
   * is read, per path, by `get_index_metrics` too, so both surfaces frame on
   * the same project slice (bd tea-rags-mcp-uebug).
   */
  readonly enrichmentProviderKeys: string[];

  constructor(deps: IngestFacadeDeps) {
    this.enrichmentProviderKeys = (deps.enrichmentProviders ?? []).map((p) => p.key);
    /* v8 ignore next 2 -- fallback for backward compat */
    const snapshotDir =
      deps.snapshotDir ?? join(process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags"), "snapshots");

    // ONE resolver for the whole slice. The ops layer and the pipeline must
    // agree on which collection a path means — the run writes what the pipeline
    // resolves and stamps what the ops layer resolves, so two independently
    // built rules would be two chances to disagree (bd tea-rags-mcp-dxa9w).
    // Built here because this is where the full registry is in scope; without a
    // registry both sides fall back to the path hash.
    const resolveCollectionForPath = deps.collectionRegistry
      ? createPathCollectionResolver(deps.collectionRegistry)
      : undefined;

    const { enrichment, indexing, reindex, gitTimePeriods } = this.buildIngestPipeline(
      deps,
      snapshotDir,
      resolveCollectionForPath,
    );
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
      healthCheckRetryAttempts: deps.healthCheckRetryAttempts,
      healthCheckRetryDelayMs: deps.healthCheckRetryDelayMs,
      collectionRegistry: deps.collectionRegistry,
      languageCodeVersions: deps.languageCodeVersions,
      driftReporter: deps.driftReporter,
      ...(resolveCollectionForPath ? { resolveCollectionForPath } : {}),
      // Beside the collection's other per-collection files, so every process
      // sharing this data dir contends on the same path (bd tea-rags-mcp-39xca.13).
      indexingLock: new CollectionIndexingLock({ lockDir: snapshotDir }),
      ...(deps.envSnapshot ? { envSnapshot: deps.envSnapshot } : {}),
      ...(deps.footprintFactory && deps.collectionRegistry && deps.statsCache && deps.allPayloadSignals
        ? {
            worktreeSeed: new WorktreeSeedOps({
              registry: deps.collectionRegistry,
              qdrant: deps.qdrant,
              statsCache: deps.statsCache,
              footprintFactory: deps.footprintFactory,
              snapshotDir,
              ...(deps.modelGuard ? { modelGuard: deps.modelGuard } : {}),
            }),
          }
        : {}),
    });

    // Stats refresh when chunk enrichment finishes. Awaited so the
    // coordinator's allSettled-then chain (itself fire-and-forget) only
    // resolves after the cache is updated — keeps callback semantics
    // observable for tests and ordered for any downstream chain.
    enrichment.onChunkEnrichmentComplete = async (collectionName) => {
      await this.indexingOps.refreshStatsByCollection(collectionName);
    };
  }

  async indexCodebase(
    path: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback,
    enrichmentProgress?: EnrichmentProgressCallback,
  ): Promise<IndexStats> {
    validateForceEnrichments(options ?? {}, this.enrichmentProviderKeys);
    validateLanguages(options ?? {}, SELECTABLE_LANGUAGES);
    return this.indexingOps.run(path, options, progressCallback, enrichmentProgress);
  }

  /** Resolve once the current run's background enrichment has settled (CLI worker). */
  async whenEnrichmentComplete(): Promise<void> {
    return this.indexingOps.whenEnrichmentComplete();
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
    resolveCollectionForPath: PathCollectionResolver | undefined,
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
    // same seam. Phase-2 of the worker-pool spec wires WorkerPoolEnrichment-
    // Executor via deps when `ingest.tune.enrichmentExecutor === "worker"`;
    // omitting it preserves the inline default (today's behavior, tests).
    const enrichmentExecutor = deps.enrichmentExecutor ?? new InlineEnrichmentExecutor();
    const recovery =
      providers.length > 0
        ? new EnrichmentRecovery(qdrant, new EnrichmentApplier(qdrant), { executor: enrichmentExecutor })
        : undefined;
    const { codegraphPool } = deps;
    // bd tea-rags-mcp-a2ddb — rewrites `codegraph.symbols.*` for points a run
    // never reaches but whose derived signals moved because the graph around
    // them did. Needs the graph client AND Qdrant AND the provider's own key,
    // which is why it is composed here rather than inside the coordinator.
    // Undefined without a codegraph pool or a deferring provider: the
    // completion tail then skips the step instead of running a stub.
    const deferringProvider = providers.find((p) => p.defersChunkEnrichment);
    const codegraphHeal =
      codegraphPool && deferringProvider
        ? createCodegraphPayloadHealRunner({
            qdrant,
            providerKey: deferringProvider.key,
            // The PHYSICAL collection name the run already resolved — the pool
            // resolves whatever string it is handed literally, so re-resolving
            // (or passing an alias) opens a second, empty shadow database.
            acquireGraphDb: async (collectionName) => (await codegraphPool.acquireWrite(collectionName)).graphDb,
          })
        : undefined;
    const enrichment = new EnrichmentCoordinator(
      qdrant,
      providers,
      recovery,
      enrichmentExecutor,
      deps.indexRunDaemonGuard,
      // kc93: one batch blob reader per run, shared across every chunk batch
      // so the backend (git pack / repository handle) is opened once instead
      // of once-per-batch. The git walk is the only consumer; non-git
      // providers ignore the injected reader. Lazy: nothing opens until the
      // first git blob read. Built by the composition root from GIT_ADAPTER.
      deps.blobReaderFactory,
      codegraphHeal,
    );
    // Codegraph DuckDB cleanup for orphan collections during alias cleanup.
    // Wired from the pool's removeCollection (closes any cached handle, then
    // unlinks `<collection>.duckdb` + `.wal`); undefined when codegraph is off.
    const codegraphRemover: PipelineRegistryDeps["codegraphRemover"] = codegraphPool
      ? async (orphan) => {
          await codegraphPool.removeCollection(orphan);
        }
      : undefined;
    // Enumerates on-disk versioned codegraph DBs for the base collection so the
    // ancient-orphan sweep can reclaim files whose Qdrant collection is gone.
    const codegraphLister: PipelineRegistryDeps["codegraphLister"] = codegraphPool
      ? (base) => codegraphPool.listCollectionDbNames(base)
      : undefined;
    const registryDeps: PipelineRegistryDeps = {
      registry: deps.collectionRegistry,
      teaRagsVersion: deps.teaRagsVersion,
      codegraphRemover,
      codegraphLister,
      envSnapshot: deps.envSnapshot,
      ...(resolveCollectionForPath ? { resolveCollectionForPath } : {}),
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

/**
 * Validate the `forceEnrichments` selectors against the registered providers.
 *
 * A selector that matches nothing is refused rather than ignored: recomputing
 * a smaller set than the caller intended finishes cleanly and looks exactly
 * like success, so the mistake would only surface as unexplained stale signals
 * much later.
 */
export function validateForceEnrichments(options: IndexOptions, availableProviderKeys: readonly string[]): void {
  const selectors = options.forceEnrichments;
  if (selectors === undefined) return;

  if (selectors.length === 0) {
    throw new InvalidParameterError("forceEnrichments", "at least one provider selector is required");
  }
  if (options.forceReindex) {
    throw new InvalidParameterError(
      "forceEnrichments",
      "cannot be combined with forceReindex — a full reindex already rebuilds the enrichment layer",
    );
  }

  const available = availableProviderKeys.length > 0 ? availableProviderKeys.join(", ") : "(none registered)";
  const { unknown } = selectProviderKeys(availableProviderKeys, selectors);
  if (unknown.length > 0) {
    throw new InvalidParameterError(
      "forceEnrichments",
      `no enrichment provider matches ${unknown.join(", ")}. Available: ${available}`,
    );
  }
}

/**
 * Validate the `languages` filter: which modes accept it, and what it may name.
 *
 * Refused on a plain incremental run. There the scope is already the changed
 * file set, so a language filter cannot make the run cheaper in any way that
 * matters — it can only hide files the sync existed to catch up on, leaving
 * their payload stale with nothing to show that it happened.
 *
 * An unsupported language is refused rather than passed through: it would
 * select zero points, and a run that touches nothing still finishes cleanly,
 * which reads as success. Validating against the languages this build can
 * CHUNK (not against the ones this index happens to contain) keeps the check
 * synchronous; a supported language that the corpus lacks is caught downstream,
 * where the empty selection is already known.
 */
export function validateLanguages(options: IndexOptions, supportedLanguages: readonly string[]): void {
  const { languages } = options;
  if (languages === undefined) return;

  if (languages.length === 0) {
    throw new InvalidParameterError("languages", "at least one language is required");
  }
  if (!options.forceReindex && options.forceEnrichments === undefined) {
    throw new InvalidParameterError(
      "languages",
      "only applies to a forced run — pass it with forceReindex or forceEnrichments. " +
        "An incremental run is already scoped to the files that changed",
    );
  }

  const { unknown } = selectLanguages(supportedLanguages, languages);
  if (unknown.length > 0) {
    throw new InvalidParameterError(
      "languages",
      `unsupported language: ${unknown.join(", ")}. Supported: ${[...supportedLanguages].sort().join(", ")}`,
    );
  }
}
