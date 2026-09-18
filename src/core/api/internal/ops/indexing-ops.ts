/**
 * IndexingOps — orchestrates first-time index, incremental reindex, and
 * deprecated explicit reindex for IngestFacade.
 *
 * Extracted from IngestFacade to keep the facade thin: indexCodebase
 * branches on collection existence, runs recovery, backfills the
 * indexing marker with modelInfo, and refreshes collection stats. That
 * orchestration lives here; the facade only dispatches.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { sampleVectors, scrollAllPoints } from "../../../adapters/qdrant/scroll.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import type { PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { LanguageCodeVersions } from "../../../contracts/types/language.js";
import type { StatsAccumulatorDescriptor } from "../../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor, ScoreBackground } from "../../../contracts/types/trajectory.js";
import type { WorktreeSeedReport } from "../../../contracts/types/worktree.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { IndexingAlreadyInProgressError, NotIndexedError } from "../../../domains/ingest/errors.js";
import { computeCollectionStats } from "../../../domains/ingest/infra/collection-stats.js";
import {
  isCollectionIndexingInFlight,
  type CollectionIndexingLock,
  type HeldCollectionIndexingLock,
} from "../../../domains/ingest/infra/index.js";
import { resolvePhysicalCollection } from "../../../domains/ingest/operations/index.js";
import type { IndexPipeline } from "../../../domains/ingest/operations/indexing.js";
import type { ReindexPipeline } from "../../../domains/ingest/operations/reindexing.js";
import { extensionsForLanguages } from "../../../domains/ingest/pipeline/chunker/config.js";
import type { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import type { DeferredChunkRecoveryHandoff } from "../../../domains/ingest/pipeline/enrichment/recovery.js";
import { parseMarkerPayload } from "../../../domains/ingest/pipeline/indexing-marker-codec.js";
import { pipelineLog } from "../../../domains/ingest/pipeline/infra/debug-logger.js";
import { StatusModule } from "../../../domains/ingest/pipeline/status-module.js";
import type { WorktreeSeedBuildIdentity } from "../../../domains/maintenance/worktree/worktree-seed-source.js";
import { hashCollectionForPath, validatePath } from "../../../infra/collection-name.js";
import { computeScoreBackground } from "../../../infra/score-background.js";
import type { StatsCache } from "../../../infra/stats-cache.js";
import type {
  ChangeStats,
  EnrichmentProgressCallback,
  IndexOptions,
  IndexStats,
  IndexStatus,
  IngestCodeConfig,
  ProgressCallback,
} from "../../../types.js";
import { isEnrichmentRecompute } from "../../public/dto/ingest.js";
import type { PathCollectionResolver } from "../collection-resolver.js";
import type { WorktreeSeedAttempt, WorktreeSeedOps, WorktreeSeedSourceRelease } from "./worktree-seed-ops.js";

type ModelInfo = { model: string; contextLength: number; dimensions: number };

/** Conservative chars-per-token estimate (2 is safe for both code and prose). */
const CHARS_PER_TOKEN = 2;
/** Safety factor: use 80% of model context to leave room for breadcrumbs/overlap. */
const CONTEXT_SAFETY_FACTOR = 0.8;
/** Default attempts for the pre-indexing embedding health probe (overridden via config). */
const DEFAULT_HEALTH_CHECK_RETRY_ATTEMPTS = 3;
/** Default pause between health-probe attempts (ms) — yields the event loop. */
const DEFAULT_HEALTH_CHECK_RETRY_DELAY_MS = 250;

/**
 * Vectors sampled to estimate the collection's similarity scale. 1200 vectors
 * yield 600 disjoint pairs — enough for a stable mean and stddev, small enough
 * (≈ 3.7 MB at 768 dimensions) that the cost does not scale with index size.
 */
const SCORE_BACKGROUND_SAMPLE = 1200;

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
  statsAccumulators?: readonly StatsAccumulatorDescriptor[];
  reranker?: Reranker;
  gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  modelGuard?: EmbeddingModelGuard;
  /**
   * Per-collection DuckDB pool. When present, `clear` and force-reindex
   * paths drop the per-collection DuckDB file alongside the Qdrant
   * collection so codegraph state does not outlive its parent index.
   */
  codegraphPool?: GraphDbClientPool;
  /**
   * Attempts for the pre-indexing embedding health probe. The probe can be
   * starved of an event-loop tick by a busy synchronous burst and time out
   * even though the provider is reachable; each retry's pause yields the loop
   * so a starved probe succeeds. A genuinely-down provider fails all attempts
   * and aborts with the typed `OllamaUnavailableError`. Defaults to 3.
   */
  healthCheckRetryAttempts?: number;
  /** Pause between health-probe attempts (ms). The pause yields the event loop. Defaults to 250. */
  healthCheckRetryDelayMs?: number;
  /**
   * Registry surface for the per-language code-version stamp
   * (bd tea-rags-mcp-frwka). Separate from the pipeline's own `record()`
   * because the stamp is a claim about WHICH layer this run rebuilt, and only
   * this layer knows the run mode. Omitted → nothing is stamped.
   */
  collectionRegistry?: LanguageVersionStamper;
  /** Per-language code versions of this build, from the composition root. */
  languageCodeVersions?: ReadonlyMap<string, LanguageCodeVersions>;
  /**
   * Drift report whose per-collection consumption this run clears
   * (bd tea-rags-mcp-p0phi). The reporter tells a reader once per server
   * session; the run that repairs the drift is what re-arms it, so a second
   * drift appearing later is still reported. Omitted → nothing is re-armed.
   */
  driftReporter?: IndexDriftConsumptionResetter;
  /**
   * How a path becomes its collection — the registry's entry when one claims
   * the path, the path hash otherwise (`createPathCollectionResolver`,
   * bd tea-rags-mcp-waj6k). EVERY derivation in this class goes through it,
   * Qdrant and DuckDB included: a project that moved keeps the collection its
   * entry recorded, and the pipeline resolves the same way, so splitting the
   * rule by addressee is what let a relocated project's run write one
   * collection while its status and stamps addressed another
   * (bd tea-rags-mcp-dxa9w). Defaults to the hash.
   */
  resolveCollectionForPath?: PathCollectionResolver;
  /**
   * The machine-wide claim on a collection (bd tea-rags-mcp-39xca.13): an
   * exclusive lock file taken before any indexing work and checked before the
   * Qdrant markers. `IngestFacade` always wires it over the snapshots dir; a
   * direct construction without it keeps only the in-process and Qdrant checks.
   */
  indexingLock?: CollectionIndexingLock;
  /**
   * Seeds a first index from a registered sibling working tree of the same
   * repository (bd tea-rags-mcp-k8gac). Omitted → every first index is an
   * ordinary one.
   */
  worktreeSeed?: Pick<WorktreeSeedOps, "seed">;
  /**
   * The env snapshot this slice's runs record into the registry — what the seed
   * gate compares a sibling's stamp against. Omitted → that axis is not compared.
   */
  envSnapshot?: Record<string, string>;
}

/** The one registry mutation this ops layer performs. */
export interface LanguageVersionStamper {
  stampLanguageVersions: (collectionName: string, stamp: Record<string, Partial<LanguageCodeVersions>>) => void;
}

/** The one drift-report mutation this ops layer performs. */
export interface IndexDriftConsumptionResetter {
  reset: (collectionName: string) => void;
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
  private readonly statsAccumulators: readonly StatsAccumulatorDescriptor[];
  private readonly reranker?: Reranker;
  private readonly gitTimePeriods?: { fileMonths: number; chunkMonths: number };
  private readonly modelGuard?: EmbeddingModelGuard;
  private readonly codegraphPool?: GraphDbClientPool;
  private readonly healthCheckRetryAttempts: number;
  private readonly healthCheckRetryDelayMs: number;
  private readonly status: StatusModule;
  private readonly collectionRegistry?: LanguageVersionStamper;
  private readonly languageCodeVersions?: ReadonlyMap<string, LanguageCodeVersions>;
  private readonly driftReporter?: IndexDriftConsumptionResetter;
  private readonly resolveCollectionForPath: PathCollectionResolver;
  /**
   * Collections an index operation of THIS process holds — from `run` entry
   * until the background enrichment it detached has settled
   * (bd tea-rags-mcp-62pgi). Keyed by the resolved collection name.
   */
  private readonly indexingCollections = new Set<string>();
  /**
   * When this process's last index operation on a collection let go of it
   * (epoch ms). Markers stamped at or before it came from that operation, so
   * they prove nothing about another session — without this, a retry after a
   * failed run would be refused for as long as the dead run's heartbeat is fresh.
   */
  private readonly indexingSettledAt = new Map<string, number>();
  /** Collection holds still waiting on the enrichment their operation detached. */
  private readonly pendingCollectionReleases = new Set<Promise<void>>();
  private readonly indexingLock?: CollectionIndexingLock;
  /** Lock files this process's operations hold, keyed like `indexingCollections`. */
  private readonly heldIndexingLocks = new Map<string, HeldCollectionIndexingLock>();
  private readonly worktreeSeed?: Pick<WorktreeSeedOps, "seed">;
  private readonly envSnapshot?: Record<string, string>;
  /**
   * Enrichment an operation started AFTER its pipeline run, keyed like
   * `indexingCollections` — today only the git rebuild of a seeded collection.
   * The collection stays claimed until it settles, exactly like the run's own
   * background enrichment. Never rejects.
   */
  private readonly trailingEnrichment = new Map<string, Promise<void>>();

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
    this.statsAccumulators = deps.statsAccumulators ?? [];
    this.reranker = deps.reranker;
    this.gitTimePeriods = deps.gitTimePeriods;
    this.modelGuard = deps.modelGuard;
    this.codegraphPool = deps.codegraphPool;
    this.healthCheckRetryAttempts = deps.healthCheckRetryAttempts ?? DEFAULT_HEALTH_CHECK_RETRY_ATTEMPTS;
    this.healthCheckRetryDelayMs = deps.healthCheckRetryDelayMs ?? DEFAULT_HEALTH_CHECK_RETRY_DELAY_MS;
    // The coordinator's provider list IS the running composition's — bootstrap
    // has already applied `enableGitMetadata`. It frames the enrichment health
    // report, which must not shrink to whatever the last run happened to touch
    // (bd tea-rags-mcp-x2u65).
    this.resolveCollectionForPath = deps.resolveCollectionForPath ?? hashCollectionForPath;
    this.status = new StatusModule(
      deps.qdrant,
      deps.snapshotDir,
      deps.codegraphPool,
      deps.enrichment.providerKeys,
      // Status answers about the SAME collection the run writes, which for a
      // relocated project is its registry entry's, not its path's hash.
      this.resolveCollectionForPath,
    );
    this.collectionRegistry = deps.collectionRegistry;
    this.languageCodeVersions = deps.languageCodeVersions;
    this.driftReporter = deps.driftReporter;
    this.indexingLock = deps.indexingLock;
    this.worktreeSeed = deps.worktreeSeed;
    this.envSnapshot = deps.envSnapshot;
  }

  /**
   * Index a codebase — first index, force re-index, or incremental fallback.
   *
   * `enrichmentProgress` (CLI only) is registered on the shared coordinator
   * before any pipeline runs, so both the full and incremental paths emit
   * per-(provider, level) progress through it. The call itself returns once
   * embeddings + alias are done (enrichment continues in the background) —
   * callers that must outlive enrichment await {@link whenEnrichmentComplete}.
   *
   * Refuses with `IndexingAlreadyInProgressError` when the collection is already
   * being indexed, here or in another session (bd tea-rags-mcp-62pgi). This is
   * the one entry both MCP `index_codebase` and the CLI worker reach, and the
   * check runs once per call — the `--force-enrichments` sync leg and recompute
   * run inside it and never meet the check again.
   */
  async run(
    path: string,
    options?: IndexOptions,
    progressCallback?: ProgressCallback,
    enrichmentProgress?: EnrichmentProgressCallback,
  ): Promise<IndexStats> {
    // Claimed before anything shared is touched: a refused call must not reset
    // the profiler or swap the progress sink out from under the running one.
    const collectionName = await this.claimCollectionForIndexing(path, options);
    let heldUntilEnrichmentSettles = false;
    try {
      const stats = await this.runClaimed(path, options, progressCallback, enrichmentProgress);
      heldUntilEnrichmentSettles = true;
      const release = this.releaseCollectionWhenEnrichmentSettles(collectionName);
      this.pendingCollectionReleases.add(release);
      void release.finally(() => this.pendingCollectionReleases.delete(release));
      return stats;
    } finally {
      if (!heldUntilEnrichmentSettles) await this.releaseCollectionForIndexing(collectionName);
    }
  }

  private async runClaimed(
    path: string,
    options: IndexOptions | undefined,
    progressCallback: ProgressCallback | undefined,
    enrichmentProgress: EnrichmentProgressCallback | undefined,
  ): Promise<IndexStats> {
    // Reset the stage profiler at the true start of an indexing session (csyve)
    // — before the embedding health probe records "embed-warmup" and before the
    // reindex path's "qdrant-setup" migration sweep. Previously reset lived in
    // BaseIndexingPipeline.scanFiles, which ran AFTER those pre-scan stages and
    // wiped their measurements.
    pipelineLog.resetProfiler();
    this.enrichment.setEnrichmentProgress(enrichmentProgress);
    if (isEnrichmentRecompute(options)) {
      return this.recomputeEnrichments(path, options.forceEnrichments, options.languages, progressCallback);
    }
    let worktreeSeed: WorktreeSeedReport | undefined;
    if (!options?.forceReindex) {
      const incremental = await this.tryIncrementalIndex(path, progressCallback);
      if (incremental) return incremental;
      // No collection yet: a first index, which a sibling working tree may seed.
      const seeded = await this.trySeedFromWorktree(path, options, progressCallback);
      if (seeded?.stats) return seeded.stats;
      worktreeSeed = seeded?.report;
    }
    // Force-reindex: drop the codegraph DB named after the LOGICAL collection
    // before the pipeline rebuilds. A versioned build writes `<name>_v<N>.duckdb`,
    // so `<name>.duckdb` is either a pre-alias legacy database or a shadow an
    // alias-addressed write left behind — and the rebuild must not inherit
    // either. Generations are left to the version sweep and `finalizeReindex`.
    // Found through the directory listing: the logical name is not a physical
    // one, so only a file that is actually there is removed (bd tea-rags-mcp-39xca.1).
    // Non-fatal when codegraph is disabled.
    if (options?.forceReindex && this.codegraphPool) {
      const logicalName = await this.resolveCollectionForPath(path);
      // Compared as text on purpose: the one database this looks for is the file
      // that carries the LOGICAL name, which the brands otherwise keep apart.
      const logicalDb = this.codegraphPool
        .listCollectionDbNames(logicalName)
        .find((name: string) => name === logicalName);
      if (logicalDb) await this.codegraphPool.removeCollection(logicalDb);
    }
    const stats = await this.fullIndex(path, options, progressCallback);
    return worktreeSeed ? { ...stats, worktreeSeed } : stats;
  }

  /**
   * Take the collection for one index operation, or refuse (bd tea-rags-mcp-62pgi,
   * tea-rags-mcp-39xca.13). Three checks, most local first:
   *
   * 1. This process — the in-process set. Check and claim are adjacent with no
   *    await between them, so two calls racing here cannot both pass.
   * 2. This machine — the exclusive indexing lock file, created before any
   *    indexing work. It closes the window in which an incremental run has
   *    published nothing to Qdrant yet (no marker until it closes, no `_run`
   *    until enrichment begins), and it separates two facades of one server.
   *    Keyed by the resolved LOGICAL name, like the set, never the alias target:
   *    a first index creates the alias and a force reindex moves it to a new
   *    `_vN` while the operation still runs, so a target-keyed lock would change
   *    identity under a live claim.
   * 3. Anywhere — the persisted Qdrant markers, for a Qdrant shared across
   *    machines. Read BEFORE this operation writes a marker of its own, so the
   *    operation can never mistake itself for another session.
   *
   * A refusal at 2 or 3 gives back everything already taken.
   */
  private async claimCollectionForIndexing(path: string, options: IndexOptions | undefined): Promise<string> {
    const collectionName = await this.resolveCollectionForPath(await validatePath(path));
    if (!(await this.tryClaimCollection(collectionName, describeIndexOperation(options)))) {
      throw new IndexingAlreadyInProgressError(path);
    }
    return collectionName;
  }

  /**
   * The three checks of {@link claimCollectionForIndexing}, answering instead of
   * throwing, so a claim on a collection the caller does not index — a seed
   * source — takes the very same locks. `false` gives back everything taken.
   */
  private async tryClaimCollection(collectionName: string, operation: string): Promise<boolean> {
    if (this.indexingCollections.has(collectionName)) return false;
    this.indexingCollections.add(collectionName);

    try {
      if (this.indexingLock) {
        const held = await this.indexingLock.tryAcquire(collectionName, operation);
        if (!held) return await this.abandonClaim(collectionName);
        this.heldIndexingLocks.set(collectionName, held);
      }
      const inFlightElsewhere = await isCollectionIndexingInFlight(this.qdrant, collectionName, {
        ownRunsSettledAt: this.indexingSettledAt.get(collectionName),
      });
      if (inFlightElsewhere) return await this.abandonClaim(collectionName);
      return true;
    } catch (error) {
      await this.abandonClaim(collectionName);
      throw error;
    }
  }

  /** Give back a claim no operation ran under; always `false`, for the caller to return. */
  private async abandonClaim(collectionName: string): Promise<false> {
    const lockReleased = this.releaseIndexingLock(collectionName);
    this.indexingCollections.delete(collectionName);
    await lockReleased;
    return false;
  }

  /**
   * Hold a seed SOURCE for the clone's duration (bd tea-rags-mcp-k8gac): the
   * same claim an index run takes, so a run on the sibling — here, in another
   * session, or on another machine sharing the Qdrant — can neither be under
   * way while its snapshot is taken nor start before the clone is done.
   *
   * Released without stamping `indexingSettledAt`: that instant discounts
   * marker evidence as this process's OWN finished run, and the seed wrote
   * none on the sibling.
   */
  private async claimSeedSource(collectionName: string): Promise<WorktreeSeedSourceRelease | undefined> {
    if (!(await this.tryClaimCollection(collectionName, "worktree-seed-source"))) return undefined;
    return async () => {
      await this.abandonClaim(collectionName);
    };
  }

  /**
   * Hold the collection until the enrichment the operation detached has settled.
   * Waits on the collection the run actually wrote — the alias target — because
   * that is the name its completion is tracked under.
   */
  private async releaseCollectionWhenEnrichmentSettles(collectionName: string): Promise<void> {
    try {
      let runCollection = resolvePhysicalCollection(collectionName, []);
      try {
        runCollection = resolvePhysicalCollection(collectionName, await this.qdrant.aliases.listAliases());
      } catch {
        // No alias listing: the run addressed the collection under this name.
      }
      await this.enrichment.whenCompletionsSettled(runCollection);
      // Awaited only when there is one: the release must land in the same tick
      // as before for every run that started nothing afterwards.
      const trailing = this.trailingEnrichment.get(collectionName);
      if (trailing) await trailing;
    } finally {
      this.trailingEnrichment.delete(collectionName);
      await this.releaseCollectionForIndexing(collectionName);
    }
  }

  /**
   * Let go of the collection in the same tick the operation ended — the instant
   * `indexingSettledAt` must record — and only then wait for the lock file to be
   * unlinked. Releasing a lock drops this process's hold on it synchronously, so
   * an operation this process admits next takes the file over instead of meeting
   * its predecessor's lock.
   */
  private async releaseCollectionForIndexing(collectionName: string): Promise<void> {
    const lockReleased = this.releaseIndexingLock(collectionName);
    this.indexingCollections.delete(collectionName);
    this.indexingSettledAt.set(collectionName, Date.now());
    await lockReleased;
  }

  /**
   * A failed release is logged, not thrown: it must not replace the operation's
   * own result or error. The lock it leaves is no longer held by this process, so
   * this process's next claim takes it over; another process finds it stale once
   * this one exits, or once its stopped heartbeat ages out.
   */
  private async releaseIndexingLock(collectionName: string): Promise<void> {
    const held = this.heldIndexingLocks.get(collectionName);
    if (!held) return;
    this.heldIndexingLocks.delete(collectionName);
    try {
      await held.release();
    } catch (error) {
      console.error(`[IndexingOps] could not release the indexing lock of ${collectionName}:`, error);
    }
  }

  /**
   * Resolve once the current run's background enrichment has settled. Lets a
   * short-lived caller (the CLI worker) keep its process alive until every
   * provider finishes, even though `run` returned at embedding completion.
   * Never rejects — failure is read from the terminal markers via getStatus.
   */
  async whenEnrichmentComplete(): Promise<void> {
    await this.enrichment.whenComplete();
    // ...and until the operation that detached it has let go of its collection,
    // so a caller that waits here and then indexes again is never refused by its
    // own finished run (bd tea-rags-mcp-62pgi).
    await Promise.all([...this.pendingCollectionReleases]);
  }

  /**
   * Deprecated explicit reindex path. Kept for IngestFacade.reindexChanges
   * which forwards here.
   */
  async reindexChanges(path: string, progressCallback?: ProgressCallback): Promise<ChangeStats> {
    // Session start for the deprecated explicit-reindex entry — reset the
    // profiler here too so "embed-warmup" survives to the stage summary (csyve).
    pipelineLog.resetProfiler();
    await this.checkEmbeddingHealth();
    const collectionName = await this.resolveCollectionForPath(await validatePath(path));
    const result = await this.reindex.reindexChanges(
      path,
      progressCallback,
      await this.syncChunkingOverrides(collectionName),
    );
    await this.refreshStats(path);
    return result;
  }

  /**
   * Indexing status with infrastructure health checks.
   *
   * Does NOT swallow typed Qdrant errors — QdrantStartingError /
   * QdrantRecoveringError / QdrantUnavailableError propagate to the MCP
   * middleware, which formats them with the appropriate retry hint. Callers
   * that just want a boolean can still use `qdrant.checkHealth()` directly.
   */
  async getStatus(path: string): Promise<IndexStatus> {
    const collectionName = await this.resolveCollectionForPath(path);

    // Real Qdrant call — serves as the health probe.
    // Throws a typed error (QdrantStartingError / QdrantRecoveringError /
    // QdrantUnavailableError) on connection failure, which propagates to
    // the MCP middleware. Works for both embedded and external Qdrant:
    //   - embedded daemon alive but HTTP not bound → Starting/Recovering
    //   - external Qdrant down → Unavailable (no daemon probe available)
    // Only if this call succeeds do we mark qdrant.available = true below.
    const exists = await this.qdrant.collectionExists(collectionName);

    const embeddingHealthy = await this.embeddings.checkHealth();
    // Track BOTH primary and fallback embedding endpoints. Symmetric with
    // qdrant.url tracking: the prime CLI digest reads these to show the
    // operator which endpoint the project was last indexed against AND its
    // configured backup. Prefer getPrimaryBaseUrl (ignores runtime
    // failover state) over getBaseUrl (currently-active URL) — for display
    // / persistence we want CONFIGURED primary. Omit fallbackUrl when the
    // provider does not expose a fallback (ONNX, Voyage, Ollama without
    // EMBEDDING_FALLBACK_URL).
    const primaryUrl = this.embeddings.getPrimaryBaseUrl?.() ?? this.embeddings.getBaseUrl?.();
    const fallbackUrl = this.embeddings.getFallbackBaseUrl?.();
    // Live-probe the fallback endpoint separately — checkHealth above only
    // probes the ACTIVE endpoint, so the digest would otherwise show the
    // fallback URL with no indication of whether the backup is actually up.
    const fallbackAvailable = fallbackUrl !== undefined ? await this.embeddings.checkFallbackHealth?.() : undefined;
    // Probe the CONFIGURED primary independently: `checkHealth` above reports
    // the ACTIVE endpoint (the fallback once failover flips), so the digest
    // would otherwise lose the primary's true status under failover. Only when
    // a primary url is known and the provider exposes the probe.
    const primaryAvailable = primaryUrl !== undefined ? await this.embeddings.checkPrimaryHealth?.() : undefined;
    // Best-effort probe of the RUNNING daemon's reported version. getServerVersion
    // swallows all errors → undefined, so this never blocks or fails get_index_status.
    const qdrantVersion = await this.qdrant.getServerVersion();
    const infraHealth: IndexStatus["infraHealth"] = {
      qdrant: {
        available: true,
        url: this.qdrant.url,
        ...(qdrantVersion !== undefined ? { version: qdrantVersion } : {}),
      },
      embedding: {
        available: embeddingHealthy,
        provider: this.embeddings.getProviderName(),
        ...(primaryUrl !== undefined ? { url: primaryUrl } : {}),
        ...(primaryAvailable !== undefined ? { primaryAvailable } : {}),
        ...(fallbackUrl !== undefined ? { fallbackUrl } : {}),
        ...(fallbackAvailable !== undefined ? { fallbackAvailable } : {}),
      },
    };

    // Collection size + quantization — embedded only, best-effort, grouped into
    // the Qdrant infra-health block. getCollectionDiskBytes returns undefined for
    // external Qdrant or on any fs error; quantization comes from the same
    // getCollectionInfo round-trip that yields status / optimizerStatus.
    if (exists) {
      const info = await this.qdrant.getCollectionInfo(collectionName);
      infraHealth.qdrant.status = info.status;
      infraHealth.qdrant.optimizerStatus = info.optimizerStatus;
      infraHealth.qdrant.quantization = info.quantization;
      const indexSizeBytes = await this.qdrant.getCollectionDiskBytes(collectionName);
      if (indexSizeBytes !== undefined) infraHealth.qdrant.indexSizeBytes = indexSizeBytes;
    }

    const status = await this.status.getIndexStatus(path);
    return { ...status, infraHealth };
  }

  /** Drop all indexed data for a codebase and invalidate the model-guard cache. */
  async clear(path: string): Promise<void> {
    const collectionName = await this.resolveCollectionForPath(path);
    this.modelGuard?.invalidate(collectionName);
    await this.status.clearIndex(path);
    // Drop the codegraph databases once Qdrant has released the collection.
    // Order matters: Qdrant first — if it fails, keeping the databases is safe
    // (they still shadow live collections); once it succeeds they are orphans.
    //
    // EVERY database on disk for the name, not the one named after it
    // (bd tea-rags-mcp-39xca.1): `clearIndex` deletes every `<name>_v<N>`
    // generation, and each generation has its own database. Removing only
    // `<name>.duckdb` — at most a shadow for a versioned collection — left them
    // all behind, and an index that later reclaimed a version number reopened
    // its old graph. Non-fatal when codegraph is disabled.
    if (this.codegraphPool) {
      for (const generation of this.codegraphPool.listCollectionDbNames(collectionName)) {
        await this.codegraphPool.removeCollection(generation);
      }
    }
  }

  /** Recompute collection stats from Qdrant and save to cache. Public for enrichment callback. */
  async refreshStats(path: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      await this.refreshStatsByCollection(await this.resolveCollectionForPath(path));
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats:", error);
    }
  }

  /**
   * Recompute stats by collection name. Public so enrichment callback can bind to it.
   *
   * Translates the incoming `collectionName` (which may be an internal versioned
   * target like `code_v2` during forceReindex) to its public alias (`code`)
   * before writing the cache. Without this translation, callbacks fired with a
   * target write to `<target>.stats.json` — a file `get_index_metrics` never
   * reads, since it always loads `<alias>.stats.json`.
   */
  async refreshStatsByCollection(collectionName: string): Promise<void> {
    if (!this.statsCache || !this.allPayloadSignals) return;
    try {
      const points = await scrollAllPoints(this.qdrant, collectionName);
      const stats = computeCollectionStats(points, this.allPayloadSignals, this.statsAccumulators, this.gitTimePeriods);
      const scoreBackground = await this.measureScoreBackground(collectionName);
      if (scoreBackground) stats.scoreBackground = scoreBackground;
      const payloadFieldKeys = payloadFieldKeysOf(this.allPayloadSignals);
      const cacheKey = await this.resolveAliasForCache(collectionName);
      this.statsCache.save(cacheKey, stats, payloadFieldKeys);
      this.reranker?.invalidateStats();
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats after chunk enrichment:", error);
    }
  }

  /**
   * Measure the collection's similarity scale — the reference search confidence
   * reads result sets against. Bounded sample, and failure is non-fatal: signal
   * stats must still be saved, confidence simply stays unavailable until the
   * next refresh succeeds.
   */
  private async measureScoreBackground(collectionName: string): Promise<ScoreBackground | undefined> {
    try {
      return computeScoreBackground(await sampleVectors(this.qdrant, collectionName, SCORE_BACKGROUND_SAMPLE));
    } catch (error) {
      console.error("[StatsCache] Failed to sample collection score background:", error);
      return undefined;
    }
  }

  /**
   * If `name` is the target of a Qdrant alias, return the alias name. Otherwise
   * return `name` unchanged. Used to keep StatsCache keyed under the public
   * alias regardless of whether the caller passed alias or internal target.
   */
  private async resolveAliasForCache(name: string): Promise<string> {
    try {
      const aliases = await this.qdrant.aliases.listAliases();
      const match = aliases.find((a) => a.collectionName === name);
      return match ? match.aliasName : name;
    } catch {
      return name;
    }
  }

  /**
   * Compute effective chunkSize based on model context window.
   *
   * - No modelInfo → return config chunkSize unchanged
   * - User didn't set INGEST_CHUNK_SIZE → use model-derived default
   * - User set INGEST_CHUNK_SIZE > defaultChunkSize → cap to defaultChunkSize.
   *   We do NOT cap to maxAllowed here: maxAllowed is the hard model ceiling,
   *   while defaultChunkSize already includes the safety factor needed to keep
   *   tokenized content under the ceiling for dense markdown / non-ASCII text.
   *   Bypassing the safety factor — as the previous "cap to maxAllowed" branch
   *   did — let chunks like 4079-char markdown overflow nomic-embed-text's
   *   2048 token window because chars/token can drop below the assumed ratio.
   * - Otherwise → keep user's chunkSize
   */
  resolveEffectiveChunkSize(modelInfo: ModelInfo | undefined): number {
    if (!modelInfo) return this.config.chunkSize;

    const maxAllowed = modelInfo.contextLength * CHARS_PER_TOKEN;
    const defaultChunkSize = Math.floor(maxAllowed * CONTEXT_SAFETY_FACTOR);

    if (!this.config.userSetChunkSize) return defaultChunkSize;
    if (this.config.chunkSize > defaultChunkSize) return defaultChunkSize;
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
    const collectionName = await this.resolveCollectionForPath(absolutePath);
    const exists = await this.qdrant.collectionExists(collectionName);
    if (!exists) return undefined;

    // Model guard before health check — the guard compares the stored model
    // NAME first, with no embed, so a wrong name is reported here rather than
    // as the health check's confusing embed() failure. It may embed the canary
    // afterwards, but only once the name already matched.
    await this.modelGuard?.ensureMatch(collectionName);
    await this.checkEmbeddingHealth();

    const overrides = await this.syncChunkingOverrides(collectionName);

    // Await recovery BEFORE the reindex (not fire-and-forget). Recovery
    // re-enriches stale/unenriched points left by prior runs; running it first
    // guarantees its payload writes land before the reindex's CompletionRunner
    // re-derives file/chunk status from countUnenriched. Fire-and-forget lost
    // that race (recovery is slower than a fast incremental run) AND recoverAll's
    // runId guard always tripped — the reindex's concurrent markStart bumped the
    // runId, so markRecoveryResult was structurally always skipped — leaving
    // degraded stuck across reindexes (tea-rags-mcp-8tp8). Sequencing recovery
    // first also makes the guard pass (no concurrent run during recovery).
    //
    // Recovery gets the PHYSICAL collection, never the alias: its codegraph
    // read opens the DuckDB file by the literal name, so the alias opens an
    // empty shadow `<alias>.duckdb`, reads zero symbols, and the applier still
    // stamps the chunks enriched — with no signals (bd tea-rags-mcp-snbzk /
    // 6goqa). Qdrant resolves aliases server-side, so recovery's Qdrant writes
    // land on the same points; everything else here stays alias-keyed.
    const recoveryCollection = resolvePhysicalCollection(collectionName, await this.qdrant.aliases.listAliases());
    // A deferring provider's owed chunks come back instead of being healed
    // before any walk (bd tea-rags-mcp-fxio5); the reindex below walks their
    // files and settles them in its own deferred chunk pass.
    const deferredChunkHandoff = await this.dispatchRecovery(recoveryCollection, absolutePath);

    const changeStats = await this.reindex.reindexChanges(path, progressCallback, {
      ...overrides,
      ...(deferredChunkHandoff.size > 0 ? { deferredChunkHandoff } : {}),
    });

    // Awaited, like the other two run paths: the refresh is what rewrites
    // `payloadFieldKeys`, and re-arming the reader before that write lands
    // leaves a window in which a search re-checks the OLD keys and is warned
    // about drift this run just repaired.
    await this.refreshStats(path);
    // Nothing corpus-wide was rebuilt, so the stamp stays put — but the payload
    // of every CHANGED file was rewritten by the current build, so the reader
    // deserves a fresh verdict rather than the one this session already spent.
    //
    // The same name the run addressed — which for a relocated project is the
    // registry's entry, not the path hash (waj6k): the consumption set being
    // re-armed is keyed by what the reader resolved, so re-arming any other
    // name leaves the one it actually consumed still spent.
    this.driftReporter?.reset(collectionName);
    return toIndexStats(changeStats);
  }

  /**
   * A first index seeded from a sibling working tree of the same repository
   * (bd tea-rags-mcp-k8gac). `undefined` when seeding is not wired; `report`
   * alone when an ordinary first index has to run; `stats` when the run is done.
   *
   * Once `WorktreeSeedOps` has cloned the sibling's footprint the run IS the
   * ordinary incremental one: it diffs this tree against the cloned snapshot by
   * content hash and re-embeds only what differs, which is the whole saving —
   * embeddings are ~92% of a first index. Three things it would not do on its
   * own, done here:
   *
   * - **Stamp the language versions.** An incremental never stamps, and an
   *   unstamped collection reports version drift. The seed gate proved the
   *   sibling's data was built by exactly this build for every language it
   *   holds, and this run embedded everything else, so the stamp a fresh index
   *   writes is true here too.
   * - **Rebuild the git layer.** Vectors, chunker payload and the codegraph are
   *   functions of file CONTENT, which the hash match proves identical — and the
   *   cloned graph is repaired by the incremental exactly as any incremental
   *   repairs it. Git signals are not: they are read from the history reachable
   *   from THIS worktree's HEAD, which may differ from the sibling's, and age
   *   with the clock since the sibling was enriched. So the git layer is
   *   recomputed for every point, as the run's background enrichment — minutes,
   *   against the embedding hours this saves, and served from the git caches the
   *   worktrees already share by common dir.
   * - **Leave nothing behind on failure.** A run that fails over a fresh seed
   *   drops the seeded collection, so the next attempt seeds again instead of
   *   inheriting a clone that no completed run ever stamped.
   */
  private async trySeedFromWorktree(
    path: string,
    options: IndexOptions | undefined,
    progressCallback?: ProgressCallback,
  ): Promise<
    { stats: IndexStats; report?: undefined } | { stats?: undefined; report: WorktreeSeedReport } | undefined
  > {
    if (!this.worktreeSeed || !this.allPayloadSignals) return undefined;
    if (options?.seedFromWorktree === false) return { report: skippedWorktreeSeed("disabled") };
    // The sibling holds what ITS runs selected; a run narrowed to other
    // extensions or patterns would inherit files it never asked for.
    if ((options?.extensions?.length ?? 0) > 0 || (options?.ignorePatterns?.length ?? 0) > 0) {
      return { report: skippedWorktreeSeed("restricted-run") };
    }

    const absolutePath = await validatePath(path);
    const collectionName = await this.resolveCollectionForPath(absolutePath);
    const attempt = await this.worktreeSeed.seed({
      targetPath: absolutePath,
      targetCollection: collectionName,
      build: this.seedBuildIdentity(this.allPayloadSignals),
      claimSource: async (source) => this.claimSeedSource(source),
    });
    if (attempt.status === "skipped") return { report: attempt };

    let stats: IndexStats | undefined;
    try {
      stats = await this.tryIncrementalIndex(path, progressCallback);
    } catch (error) {
      await this.dropFailedSeed(path, collectionName);
      throw error;
    }
    if (!stats) {
      // The clone reported success yet no collection answers for the path —
      // index from scratch rather than trust it.
      return {
        report: {
          status: "skipped",
          reason: "no-compatible-sibling",
          rejected: [
            ...attempt.rejected,
            {
              ...attempt.source,
              reason: "clone-failed",
              detail: "the seeded collection is not visible after the clone",
            },
          ],
        },
      };
    }

    this.stampLanguageVersions(collectionName, undefined, "all");
    this.driftReporter?.reset(collectionName);
    const gitRefresh = this.startSeedGitRefresh(path, absolutePath, collectionName);
    return { stats: { ...stats, worktreeSeed: seededWorktreeReport(attempt, stats, gitRefresh) } };
  }

  /** What this run would stamp onto a collection it indexed from scratch — the seed gate's reference. */
  private seedBuildIdentity(allPayloadSignals: readonly PayloadSignalDescriptor[]): WorktreeSeedBuildIdentity {
    return {
      payloadFieldKeys: payloadFieldKeysOf(allPayloadSignals),
      ...(this.languageCodeVersions ? { languageCodeVersions: this.languageCodeVersions } : {}),
      ...(this.envSnapshot ? { envSnapshot: this.envSnapshot } : {}),
      embeddingModel: this.embeddings.getModel(),
      codegraphEnabled: this.codegraphPool !== undefined,
      qdrant: { embedded: this.qdrant.isEmbedded, url: this.qdrant.url },
    };
  }

  /** Best-effort: the run's own error is what the caller must see. */
  private async dropFailedSeed(path: string, collectionName: string): Promise<void> {
    try {
      await this.clear(path);
    } catch (error) {
      console.error(`[IndexingOps] could not drop the seeded collection ${collectionName} after a failed run:`, error);
    }
  }

  /**
   * Start the git rebuild of a seeded collection and tie it to the collection's
   * claim — `releaseCollectionWhenEnrichmentSettles` waits for it — so the
   * rebuild is this run's background enrichment in every respect: the call
   * returns once the index is searchable, and nothing else indexes the
   * collection until the rebuild is done.
   */
  private startSeedGitRefresh(
    path: string,
    absolutePath: string,
    collectionName: string,
  ): "background" | "not-applicable" {
    if (!this.enrichment.providerKeys.includes("git")) return "not-applicable";
    this.trailingEnrichment.set(collectionName, this.refreshSeededGitLayer(path, absolutePath, collectionName));
    return "background";
  }

  /** Never rejects: a failed rebuild is reported through the terminal markers and the log. */
  private async refreshSeededGitLayer(path: string, absolutePath: string, collectionName: string): Promise<void> {
    try {
      // Physical, never the alias — the recompute's run state and any codegraph
      // read address the generation by its literal name (bd tea-rags-mcp-snbzk).
      const physical = resolvePhysicalCollection(collectionName, await this.qdrant.aliases.listAliases());
      await this.enrichment.recomputeEnrichments(physical, absolutePath, ["git"]);
      await this.refreshStats(path);
      this.driftReporter?.reset(collectionName);
    } catch (error) {
      console.error(`[IndexingOps] git rebuild of the seeded collection ${collectionName} failed:`, error);
    }
  }

  /**
   * Rebuild the enrichment layer over the whole index, without re-embedding.
   *
   * Three things happen in a fixed order, and each one is load-bearing:
   *
   * 1. **Guard.** A collection must already exist. Without this the sync below
   *    would index the project from scratch and pay for every embedding —
   *    precisely the cost this path exists to avoid — while still looking like
   *    a successful recompute.
   * 2. **Sync.** Chunk point ids hash file content, so a recompute against a
   *    working tree that has moved on writes payload onto ids that are no
   *    longer in the index. Qdrant treats that as a no-op, so the signals would
   *    simply vanish with no error anywhere. The sync is therefore not optional
   *    and its failure aborts the run rather than degrading it.
   * 3. **Recompute, then stats.** Percentiles and label maps are computed over
   *    the payload, so they are refreshed regardless of which providers were
   *    selected — a partial recompute still moves the distributions.
   */
  private async recomputeEnrichments(
    path: string,
    selectors: readonly string[],
    languages: readonly string[] | undefined,
    progressCallback?: ProgressCallback,
  ): Promise<IndexStats> {
    const absolutePath = await validatePath(path);
    const aliasName = await this.resolveCollectionForPath(absolutePath);
    if (!(await this.qdrant.collectionExists(aliasName))) {
      throw new NotIndexedError(path);
    }
    // Address the PHYSICAL collection, never the alias. Qdrant resolves aliases
    // server-side, so its own calls work either way — but the codegraph pool
    // opens the DuckDB file by the literal string it is handed, so the alias
    // creates a second, shadow `<alias>.duckdb` that no reader ever opens. The
    // recompute's graph writes, `cg_run_stats` included, then land in a file
    // prime does not read and the resolve breakdown looks like it vanished
    // (bd tea-rags-mcp-snbzk; same mechanism as 6goqa).
    const collectionName = resolvePhysicalCollection(aliasName, await this.qdrant.aliases.listAliases());

    // The sync leg is deliberately NOT forced: the recompute below owns the
    // forced re-extraction on this path, and forcing both meant paying for it
    // twice (bd tea-rags-mcp-6aytq).
    //
    // The recompute is the only leg that can finish the job. It reads the chunk
    // set back out of the index, so it is the only one holding the chunk ids a
    // file overlay is applied through, and the only one that runs the deferred
    // chunk pass — while its own file phase re-extracts every stored file
    // unconditionally, no hash gate (EnrichmentCoordinator#recomputeEnrichments
    // → FilePhase#onBatch → the provider's streamFileBatch). Forcing the repair
    // pass as well therefore added a whole pass-1 + pass-2 over the same corpus
    // whose result the recompute immediately rebuilt from scratch.
    //
    // Measured on taxdome 2026-08-14 17:30, `--force-enrichments codegraph
    // --languages typescript`: the forced repair ran pass-1 over 10,621 files
    // and pass-2 over all of them, reached ALL_COMPLETE at +225.0s having
    // written payload to `matchedFiles: 0`, and the recompute then started its
    // own pass-1 from zero at +262s — 113s+ of pure duplication, and the run's
    // 330s budget was gone before the leg that writes payload could finish.
    //
    // The sync keeps its ORDINARY drift repair (unchanged, hash-diffed), which
    // is what still heals a provider store that fell behind — including rows for
    // eligible files carrying no chunks, the one set the recompute cannot see.
    //
    // It DOES carry the chunking overrides every other sync carries: a file the
    // tree changed is re-chunked here, and chunked at another size its
    // boundaries — and point ids — would disagree with every other file's.
    const changeStats = await this.reindex.reindexChanges(
      path,
      progressCallback,
      await this.syncChunkingOverrides(aliasName),
    );
    const startedAt = Date.now();
    const enrichmentMetrics = await this.enrichment.recomputeEnrichments(
      collectionName,
      absolutePath,
      selectors,
      languages,
    );
    const enrichmentDurationMs = Date.now() - startedAt;
    await this.refreshStats(path);
    // The recompute rebuilt EDGES for every point of the selected languages and
    // nothing else — point ids never moved — so only the two edge axes may
    // advance. Claiming `grammar` / `chunking` here would silence a hint that
    // is still true. A git-only recompute touches no language layer at all.
    if (selectors.some(isCodegraphSelector)) {
      this.stampLanguageVersions(aliasName, languages, "codegraph");
    }
    // Keyed by the LOGICAL name a search request resolves to, never the
    // physical target resolved above: the reporter's consumption set and the
    // registry entry are both addressed that way, so re-arming or stamping the
    // physical name would clear and claim entries nobody ever recorded.
    this.driftReporter?.reset(aliasName);

    // Report the RECOMPUTE's own numbers, not the sync's. The sync leg is a
    // near-no-op here, so inheriting its (empty) enrichment fields would state
    // that nothing was enriched on a pass whose entire purpose was enriching.
    return {
      ...toIndexStats(changeStats),
      enrichmentStatus: "completed",
      enrichmentDurationMs,
      enrichmentMetrics,
    };
  }

  private async fullIndex(
    path: string,
    options: IndexOptions | undefined,
    progressCallback?: ProgressCallback,
  ): Promise<IndexStats> {
    await this.checkEmbeddingHealth();
    const modelInfo = await this.resolveModelInfo();
    const effectiveChunkSize = this.resolveEffectiveChunkSize(modelInfo);
    const result = await this.indexing.indexCodebase(path, applyLanguageFilter(options), progressCallback, {
      chunkSize: effectiveChunkSize,
      modelInfo,
    });
    await this.refreshStats(path);
    // A first index or a force rebuilds the chunk set AND the enrichment layer
    // from scratch, so every axis is genuinely current afterwards. This is the
    // only path that may advance `grammar` / `chunking`.
    //
    // Resolved, not hashed, even though this run CREATES the collection: the
    // pipeline resolves the same way, so for a path nothing has registered the
    // two agree on the hash, and for a relocated project both land on the entry
    // the run actually rewrote (bd tea-rags-mcp-dxa9w).
    const collectionName = await this.resolveCollectionForPath(path);
    this.stampLanguageVersions(collectionName, options?.languages, "all");
    this.driftReporter?.reset(collectionName);
    return result;
  }

  /**
   * Record which build produced this index, for the languages the run covered
   * (bd tea-rags-mcp-frwka). `scope` is the run mode, not a preference: a
   * recompute may only claim the axes it actually rebuilt.
   *
   * No `languages` selector means the run covered everything the build
   * supports. Stamping absent languages is harmless — the comparison is
   * restricted to languages the index actually holds — and it is what lets a
   * later `--force` on a project that gains a new language start from a
   * truthful stamp.
   */
  private stampLanguageVersions(
    collectionName: string,
    languages: readonly string[] | undefined,
    scope: "all" | "codegraph",
  ): void {
    const versions = this.languageCodeVersions;
    if (!this.collectionRegistry || !versions) return;
    const selected = languages && languages.length > 0 ? languages : [...versions.keys()];
    const stamp: Record<string, Partial<LanguageCodeVersions>> = {};
    for (const language of selected) {
      const current = versions.get(language);
      if (!current) continue;
      stamp[language] =
        scope === "all" ? { ...current } : { walker: current.walker, codegraphSchema: current.codegraphSchema };
    }
    if (Object.keys(stamp).length > 0) this.collectionRegistry.stampLanguageVersions(collectionName, stamp);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Pre-indexing embedding health probe. Retries on failure with a short pause
   * between attempts: the probe can be starved of an event-loop tick by a busy
   * synchronous burst and fail even though the provider is reachable, and the
   * pause yields the loop so the retry succeeds. A genuinely-down provider
   * fails every attempt and the last typed error (e.g. `OllamaUnavailableError`)
   * propagates to abort indexing exactly as before.
   */
  private async checkEmbeddingHealth(): Promise<void> {
    // "embed-warmup" stage (csyve) — time the whole probe (incl. retries) on
    // both the success and failure exit so the stage summary can confirm or
    // rule out a cold-model warmup as the source of the setup-window swing.
    // finally only records the measurement; control flow is unchanged.
    const warmupStart = Date.now();
    try {
      const attempts = Math.max(1, this.healthCheckRetryAttempts);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          await this.embeddings.embed("health");
          return;
        } catch (error) {
          lastError = error;
          if (attempt < attempts) {
            await new Promise((resolve) => setTimeout(resolve, this.healthCheckRetryDelayMs));
          }
        }
      }
      throw lastError;
    } finally {
      pipelineLog.addStageTime("embed-warmup", Date.now() - warmupStart);
    }
  }

  private async resolveModelInfo(): Promise<ModelInfo | undefined> {
    try {
      return await this.embeddings.resolveModelInfo?.();
    } catch {
      return undefined;
    }
  }

  /**
   * What every sync of an EXISTING collection hands the pipeline, so a file it
   * re-chunks gets the size a full index gave every other file: the model's
   * info and the chunk size derived from it (`resolveEffectiveChunkSize`).
   * The one place the pair is built — the incremental run, the
   * `--force-enrichments` sync leg and the deprecated explicit reindex all take
   * it from here, because a sync that fell back to `config.chunkSize` chunked
   * its changed files at another size than the rest of the index.
   */
  private async syncChunkingOverrides(
    collectionName: string,
  ): Promise<{ chunkSize: number; modelInfo: ModelInfo | undefined }> {
    const modelInfo = await this.resolveOrBackfillModelInfo(collectionName);
    return { chunkSize: this.resolveEffectiveChunkSize(modelInfo), modelInfo };
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

  private async dispatchRecovery(
    collectionName: PhysicalCollectionName,
    absolutePath: string,
  ): Promise<DeferredChunkRecoveryHandoff> {
    // Awaited, best-effort. runRecovery is cheap when there's no work:
    // recoverFileLevel/recoverChunkLevel short-circuit on empty scroll, so the
    // healthy path pays only a couple of lightweight count/scroll calls. When
    // there IS stale unenriched state, awaiting pays the one-time recovery cost
    // up front so the following reindex finalizes on clean counts. No disk-based
    // completion flag — the collection itself is the only source of truth, so an
    // incremental reindex with 0 changes still triggers recovery for state left
    // by prior runs. Recovery failure is logged but never blocks the reindex —
    // it is best-effort, and the reindex's own enrichment still runs.
    //
    // The result is the chunks recovery handed to the reindex instead of
    // healing them (bd tea-rags-mcp-fxio5): a deferring provider's chunk signals
    // need the walker's line map, which only the run's own repair walk writes.
    // No recovery configured, or a failed one, hands nothing off.
    try {
      return (await this.enrichment.runRecovery(collectionName, absolutePath)) ?? new Map();
    } catch (error) {
      console.error("[IndexingOps] pre-reindex enrichment recovery failed (continuing with reindex):", error);
      return new Map();
    }
  }
}

/**
 * The payload keys a stats refresh records for this build. One definition for
 * the writer (`refreshStatsByCollection`) and for the seed gate that compares a
 * sibling's recorded keys against it, so the two can never disagree.
 */
function payloadFieldKeysOf(signals: readonly PayloadSignalDescriptor[]): string[] {
  return [...signals.map((d) => d.key), "navigation"];
}

/** A first index that ran without a seed, and why. */
function skippedWorktreeSeed(reason: "disabled" | "restricted-run"): WorktreeSeedReport {
  return { status: "skipped", reason, rejected: [] };
}

/**
 * The report of a seeded first index, from the incremental run over it. A file
 * of the sibling's snapshot was copied verbatim unless this run re-embedded it
 * (modified) or dropped it (deleted, newly ignored).
 */
function seededWorktreeReport(
  attempt: Extract<WorktreeSeedAttempt, { status: "seeded" }>,
  stats: IndexStats,
  gitRefresh: "background" | "not-applicable",
): WorktreeSeedReport {
  const change = stats.changeDetails;
  const modified = change?.filesModified ?? 0;
  const removed = (change?.filesDeleted ?? 0) + (change?.filesNewlyIgnored ?? 0);
  return {
    status: "seeded",
    source: attempt.source,
    filesCopied: Math.max(0, attempt.sourceFiles - modified - removed),
    filesIndexed: (change?.filesAdded ?? 0) + modified,
    filesRemoved: removed,
    gitRefresh,
    rejected: attempt.rejected,
  };
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
      filesRetried: changeStats.filesRetried,
    },
  };
}

/**
 * Turn a `languages` selection into the extension filter the scanner accepts.
 *
 * The scanner has no notion of a language, so this is where the two vocabularies
 * meet — and why restricting a full reindex needed no new plumbing at all.
 *
 * When the caller ALSO passed explicit extensions the two are intersected, not
 * overridden: both are restrictions, and honouring only one would widen the run
 * past what was asked for. Absent `languages`, options pass through untouched,
 * which keeps an ordinary force reindex byte-identical to before.
 */
/**
 * Whether a `forceEnrichments` selector rebuilds the codegraph layer, and so
 * whether the language version stamp's edge axes may advance. `all` counts;
 * the family is matched by prefix so `codegraph.symbols` (and any future
 * sub-key) is covered without a second list to keep in sync.
 */
function isCodegraphSelector(selector: string): boolean {
  return selector === "all" || selector === "codegraph" || selector.startsWith("codegraph.");
}

/** What an index operation is doing, as its indexing lock tells whoever finds the collection held. */
function describeIndexOperation(options: IndexOptions | undefined): string {
  if (isEnrichmentRecompute(options)) return "force-enrichments";
  if (options?.forceReindex) return "force-reindex";
  return "index-codebase";
}

export function applyLanguageFilter(options: IndexOptions | undefined): IndexOptions | undefined {
  const languages = options?.languages;
  if (!options || !languages || languages.length === 0) return options;

  const fromLanguages = extensionsForLanguages(languages);
  const extensions = options.extensions
    ? options.extensions.filter((ext) => fromLanguages.includes(ext))
    : fromLanguages;

  return { ...options, extensions };
}
