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
import { scrollAllPoints } from "../../../adapters/qdrant/scroll.js";
import type { StatsAccumulatorDescriptor } from "../../../contracts/types/stats-accumulator.js";
import type { PayloadSignalDescriptor } from "../../../contracts/types/trajectory.js";
import type { Reranker } from "../../../domains/explore/reranker.js";
import { INDEXING_METADATA_ID } from "../../../domains/ingest/constants.js";
import { computeCollectionStats } from "../../../domains/ingest/infra/collection-stats.js";
import type { IndexPipeline } from "../../../domains/ingest/operations/indexing.js";
import type { ReindexPipeline } from "../../../domains/ingest/operations/reindexing.js";
import type { EnrichmentCoordinator } from "../../../domains/ingest/pipeline/enrichment/coordinator.js";
import { parseMarkerPayload } from "../../../domains/ingest/pipeline/indexing-marker-codec.js";
import { StatusModule } from "../../../domains/ingest/pipeline/status-module.js";
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
/** Default attempts for the pre-indexing embedding health probe (overridden via config). */
const DEFAULT_HEALTH_CHECK_RETRY_ATTEMPTS = 3;
/** Default pause between health-probe attempts (ms) — yields the event loop. */
const DEFAULT_HEALTH_CHECK_RETRY_DELAY_MS = 250;

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
    this.status = new StatusModule(deps.qdrant, deps.snapshotDir);
  }

  /** Index a codebase — first index, force re-index, or incremental fallback. */
  async run(path: string, options?: IndexOptions, progressCallback?: ProgressCallback): Promise<IndexStats> {
    if (!options?.forceReindex) {
      const incremental = await this.tryIncrementalIndex(path, progressCallback);
      if (incremental) return incremental;
    }
    // Force-reindex: drop the per-collection codegraph DB before the
    // pipeline rebuilds. The DuckDB file is keyed by the public alias
    // (collection name), not by the versioned target — so without an
    // explicit purge the new index would inherit stale symbol rows from
    // the previous generation. Non-fatal when codegraph is disabled.
    if (options?.forceReindex && this.codegraphPool) {
      const absolutePath = await validatePath(path);
      const collectionName = resolveCollectionName(absolutePath);
      await this.codegraphPool.removeCollection(collectionName);
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

  /**
   * Indexing status with infrastructure health checks.
   *
   * Does NOT swallow typed Qdrant errors — QdrantStartingError /
   * QdrantRecoveringError / QdrantUnavailableError propagate to the MCP
   * middleware, which formats them with the appropriate retry hint. Callers
   * that just want a boolean can still use `qdrant.checkHealth()` directly.
   */
  async getStatus(path: string): Promise<IndexStatus> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);

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
    const infraHealth: IndexStatus["infraHealth"] = {
      qdrant: { available: true, url: this.qdrant.url },
      embedding: {
        available: embeddingHealthy,
        provider: this.embeddings.getProviderName(),
        ...(primaryUrl !== undefined ? { url: primaryUrl } : {}),
        ...(fallbackUrl !== undefined ? { fallbackUrl } : {}),
      },
    };

    if (exists) {
      const info = await this.qdrant.getCollectionInfo(collectionName);
      infraHealth.qdrant.status = info.status;
      infraHealth.qdrant.optimizerStatus = info.optimizerStatus;
    }

    const status = await this.status.getIndexStatus(path);
    return { ...status, infraHealth };
  }

  /** Drop all indexed data for a codebase and invalidate the model-guard cache. */
  async clear(path: string): Promise<void> {
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    this.modelGuard?.invalidate(collectionName);
    await this.status.clearIndex(path);
    // Drop the per-collection codegraph DuckDB file once Qdrant has
    // released its collection. Order matters: Qdrant first — if it
    // fails, retaining the DuckDB file is safe (still shadows a live
    // collection); after Qdrant succeeds, the DuckDB file is orphaned
    // and removed here. Non-fatal when codegraph is disabled.
    if (this.codegraphPool) {
      await this.codegraphPool.removeCollection(collectionName);
    }
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
      const payloadFieldKeys = [...this.allPayloadSignals.map((d) => d.key), "navigation"];
      const cacheKey = await this.resolveAliasForCache(collectionName);
      this.statsCache.save(cacheKey, stats, payloadFieldKeys);
      this.reranker?.invalidateStats();
    } catch (error) {
      console.error("[StatsCache] Failed to refresh collection stats after chunk enrichment:", error);
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

  /**
   * Pre-indexing embedding health probe. Retries on failure with a short pause
   * between attempts: the probe can be starved of an event-loop tick by a busy
   * synchronous burst and fail even though the provider is reachable, and the
   * pause yields the loop so the retry succeeds. A genuinely-down provider
   * fails every attempt and the last typed error (e.g. `OllamaUnavailableError`)
   * propagates to abort indexing exactly as before.
   */
  private async checkEmbeddingHealth(): Promise<void> {
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
    // Fire-and-forget. runRecovery is cheap when there's no work:
    // recoverFileLevel/recoverChunkLevel short-circuit on empty scroll, and
    // the updateEnrichmentMarker writeback is guarded by runId snapshot inside
    // runRecovery. No disk-based completion flag — the only source of truth is
    // the collection itself, so an incremental reindex with 0 changes still
    // triggers recovery for stale/unenriched state left by prior runs.
    void this.enrichment.runRecovery(collectionName, absolutePath).catch(() => {});
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
