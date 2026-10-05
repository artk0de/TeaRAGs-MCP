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
import { EMBEDDED_MARKER } from "../../../adapters/qdrant/embedded/daemon.js";
import { chunkPointsFilter } from "../../../adapters/qdrant/service-points.js";
import type { CollectionAlias, PhysicalCollectionName } from "../../../contracts/types/collection-identity.js";
import type { EnrichmentRunHandle } from "../../../contracts/types/enrichment-executor.js";
import {
  embeddingThroughputOptimumKey,
  type CollectionRegistryPort,
  type EmbeddingProducerStarvation,
  type EmbeddingThroughputOptimumWrite,
  type PathCollectionResolver,
  type RegistryGitState,
} from "../../../contracts/types/registry.js";
import { hashCollectionForPath, validatePath } from "../../../infra/collection-name.js";
import { TeaRagsError } from "../../../infra/errors.js";
import {
  findGitToplevel,
  readRepoGitState,
  readWorkingTreeDirty,
  readWorkingTreeDirtyPaths,
} from "../../../infra/repo-git-state.js";
import type { ChunkLookupEntry, EnrichmentMetrics, IngestCodeConfig } from "../../../types.js";
import type { IngestDependencies } from "../factory.js";
import type { CodegraphDbLister, CodegraphDbRemover } from "../infra/alias-cleanup.js";
import { ChunkerPool, type ChunkerPoolPort } from "./chunker/infra/pool.js";
import { EmbeddingThroughputTuner, type EmbeddingEndpointThroughputOptimum } from "./embedding-throughput-tuner.js";
import type { EnrichmentCoordinator } from "./enrichment/coordinator.js";
import { reindexRunSpec, type EnrichmentRunSpec, type StreamedEnrichmentRunInput } from "./enrichment/run-spec.js";
import { ChunkPipeline } from "./index.js";
import { INDEXING_HEARTBEAT_INTERVAL_MS } from "./indexing-marker-codec.js";
import { storeIndexingMarker, updateHeartbeat } from "./indexing-marker.js";
import { pipelineLog } from "./infra/debug-logger.js";
import { defaultChunkerPoolSize } from "./infra/pool-defaults.js";
import { FileScanner } from "./scanner.js";
import type { PipelineConfig } from "./types.js";

export interface ProcessingContext {
  chunkerPool: ChunkerPoolPort;
  chunkPipeline: ChunkPipeline;
  /** The enrichment run this processing feeds; every per-run coordinator call names it. */
  enrichmentRun: EnrichmentRunHandle;
}

export interface EnrichmentStatusResult {
  status: "completed" | "background" | "skipped";
  metrics?: EnrichmentMetrics;
}

/**
 * How a run closes, as handed to `BaseIndexingPipeline#sealRun`. The steps are
 * the pipeline's own; their ORDER is the base's (bd tea-rags-mcp-7njy).
 */
export interface IndexingRunSealSpec {
  /** Physical collection that receives the completion marker. */
  targetCollection: PhysicalCollectionName;
  /**
   * Stable name the registry entry is recorded under — the alias, never the
   * versioned target, so the entry survives a version bump.
   */
  collectionAlias: string;
  absolutePath: string;
  /** Model capabilities learnt during the run, carried onto the marker. */
  modelInfo?: { model: string; contextLength: number; dimensions: number };
  /**
   * Make the collection the one readers see (the force path's alias
   * create/switch). Runs BEFORE the marker: a failed promotion must leave no
   * collection marked complete behind an alias that still points elsewhere.
   */
  promote?: () => Promise<void>;
  /** Persist the run's sync state (snapshot, checkpoint) once the marker landed. */
  persist: () => Promise<void>;
  /** What the run's embedding throughput tuner settled on, per endpoint (bd tea-rags-mcp-7ju66). */
  embeddingThroughputOptima?: EmbeddingEndpointThroughputOptimum[];
  /** Whether the run's embed stage waited on the chunk producer (bd tea-rags-mcp-y1ynz). */
  embeddingProducerStarvation?: EmbeddingProducerStarvation;
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
  // Workers run as child processes (ProcessTransport), so concurrent parsing
  // is safe — each process owns its own tree-sitter native heap (yl9tv).
  chunkerPoolSize: defaultChunkerPoolSize(),
  fileConcurrency: 50,
};

/** Optional collaborators wired by the facade — kept out of the long positional list. */
export interface PipelineRegistryDeps {
  registry?: CollectionRegistryPort;
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
  /**
   * Full effective env set of this run (canonical keys, code defaults
   * materialized), built by the bootstrap composition root from the parsed
   * config (`buildRegistryEnvSnapshot`) — the pipeline never reads
   * process.env. Persisted verbatim into `CollectionEntry.env` so a bare-env
   * CLI reindex reproduces the same configuration. Omitted only in direct
   * (non-bootstrap) constructions — then no env snapshot is recorded.
   */
  envSnapshot?: Record<string, string>;
  /**
   * How a path becomes the collection this run writes into — the project
   * registry's entry when one claims the path, the path hash otherwise
   * (`createPathCollectionResolver`, bd tea-rags-mcp-dxa9w). Injected as a
   * function because the rule consults the registry and this domain may not
   * reach the api layer.
   *
   * Deriving the hash here is what made an alias-addressed run on a RELOCATED
   * project mint a brand-new `code_<hash(newPath)>` beside the registered
   * collection and register an orphan entry for it, while every reader kept
   * resolving the old name. Defaults to the hash, which is what an
   * unregistered path resolves to either way.
   */
  resolveCollectionForPath?: PathCollectionResolver;
}

export abstract class BaseIndexingPipeline {
  protected readonly tuning: PipelineTuning;
  protected readonly registry: CollectionRegistryPort | undefined;
  protected readonly teaRagsVersion: string;
  protected readonly codegraphRemover: CodegraphDbRemover | undefined;
  protected readonly codegraphLister: CodegraphDbLister | undefined;
  protected readonly envSnapshot: Record<string, string> | undefined;
  protected readonly resolveCollectionForPath: PathCollectionResolver;
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
    this.envSnapshot = registryDeps?.envSnapshot;
    this.resolveCollectionForPath = registryDeps?.resolveCollectionForPath ?? hashCollectionForPath;
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
      INDEXING_HEARTBEAT_INTERVAL_MS,
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

  /**
   * The run's two coordinates: where the files are, and which collection they
   * belong to. The second one is NOT derivable from the first — a project that
   * moved keeps the collection its registry entry recorded — so it comes from
   * the injected rule, never from the path hash (bd tea-rags-mcp-dxa9w).
   */
  protected async resolveContext(path: string): Promise<{
    absolutePath: string;
    collectionName: CollectionAlias;
  }> {
    const absolutePath = await validatePath(path);
    const aliasCollectionName = await this.resolveCollectionForPath(absolutePath);
    return { absolutePath, collectionName: aliasCollectionName };
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
    // "scan" stage = full project scan: ignore-pattern load + directory walk
    // (csyve). resetProfiler now runs once at the session start in IndexingOps,
    // not here — recording it here would wipe the pre-scan setup stages
    // (embed-warmup, qdrant-setup on the reindex path) that ran earlier.
    pipelineLog.stageStart("scan");
    await scanner.loadIgnorePatterns(absolutePath);
    const files = await scanner.scanDirectory(absolutePath);
    pipelineLog.stageEnd("scan");
    return files;
  }

  // ── Processing lifecycle ─────────────────────────────────

  protected initProcessing(
    physicalCollectionName: PhysicalCollectionName,
    absolutePath: string,
    scanner: FileScanner,
    chunkSizeOverride?: number,
    fileCount = 0,
    /**
     * The run's per-file SHA256, keyed repo-relative. Supplied by the paths that
     * have no incremental scan to project it off — the full index and `--force`
     * (bd tea-rags-mcp-o317j). The incremental path leaves it undefined: its
     * hashes reach the coordinator through `runRepairPass`.
     */
    contentHashes?: ReadonlyMap<string, string>,
  ): ProcessingContext {
    const chunkerPool = this.createChunkerPool(chunkSizeOverride, absolutePath);
    const chunkPipeline = this.createChunkPipeline(physicalCollectionName);
    // "codegraph-init" stage (csyve) = enrichment beginRun: per-provider context
    // build + (cross-pass) codegraph beginExtractionRun spill reset + phase init.
    // The DuckDB daemon connect is fire-and-forget inside beginRun and overlaps
    // file processing, so it is intentionally not folded into this measurement.
    const codegraphInitStart = Date.now();
    const enrichmentRun = this.setupEnrichmentHooks(chunkPipeline, {
      absolutePath,
      collection: physicalCollectionName,
      fileCount,
      ignoreFilter: scanner.getIgnoreFilter(),
      contentHashes,
    });
    pipelineLog.addStageTime("codegraph-init", Date.now() - codegraphInitStart);
    chunkPipeline.start();
    return { chunkerPool, chunkPipeline, enrichmentRun };
  }

  protected async finalizeProcessing(
    ctx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<() => EnrichmentStatusResult> {
    await this.flushAndShutdown(ctx.chunkPipeline, ctx.chunkerPool);
    return this.startEnrichment(chunkMap, ctx.enrichmentRun);
  }

  /**
   * The closing skeleton every run shares, whatever work it did:
   * `promote` → completion marker → `persist` → registry entry. The order is
   * the invariant (operations/CLAUDE.md): the alias is finalized BEFORE the
   * marker, so a promotion failure — thrown, never returned — leaves the new
   * collection unmarked for orphan cleanup instead of marked complete behind an
   * alias that still points at the previous version.
   */
  protected async sealRun(spec: IndexingRunSealSpec): Promise<void> {
    await spec.promote?.();
    await storeIndexingMarker(this.qdrant, this.embeddings, spec.targetCollection, true, spec.modelInfo);
    await spec.persist();
    await this.recordRegistryEntry(
      spec.collectionAlias,
      spec.absolutePath,
      spec.embeddingThroughputOptima,
      spec.embeddingProducerStarvation,
    );
  }

  /**
   * Close a run that streamed chunks: drain the processing context and start
   * enrichment, let the caller report the drained pipeline (`onFlushed`), seal
   * the run, and only then read the enrichment status — so the status reflects
   * whatever enrichment managed while the run was being sealed.
   */
  protected async completePipeline(
    ctx: ProcessingContext,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    seal: IndexingRunSealSpec,
    onFlushed?: () => void,
  ): Promise<EnrichmentStatusResult> {
    const getEnrichmentStatus = await this.finalizeProcessing(ctx, chunkMap);
    onFlushed?.();
    // The drained chunk pipeline knows what its throughput tuner settled on and
    // whether its embed stage starved; the registry entry this seal records
    // carries both — the optimum to the next run, the verdict to the run's status.
    await this.sealRun({
      ...seal,
      embeddingThroughputOptima: ctx.chunkPipeline?.settledThroughputOptima(),
      embeddingProducerStarvation: ctx.chunkPipeline?.embeddingProducerStarvation(),
    });
    return getEnrichmentStatus();
  }

  /**
   * Persist a project-registry entry for the freshly indexed collection.
   * Failure is logged to stderr but never aborts the indexing run — the
   * registry is an out-of-band catalogue, not part of the index transaction.
   *
   * MUST be called with the canonical (alias) name, not the versioned target.
   * countPoints transparently resolves the alias to its current collection.
   */
  /**
   * The collection's actual vector width, falling back to the provider's
   * configured dimensions when Qdrant cannot report one. Never lets a registry
   * write fail the run — the fallback is the pre-existing behaviour.
   */
  private async resolveCollectionVectorSize(collectionName: string): Promise<number> {
    try {
      const info = await this.qdrant.getCollectionInfo(collectionName);
      return info.vectorSize || this.embeddings.getDimensions();
    } catch {
      return this.embeddings.getDimensions();
    }
  }

  protected async recordRegistryEntry(
    collectionName: string,
    absolutePath: string,
    throughputOptima: readonly EmbeddingEndpointThroughputOptimum[] = [],
    producerStarvation?: EmbeddingProducerStarvation,
  ): Promise<void> {
    if (!this.registry) return;
    this.recordThroughputOptima(throughputOptima);
    try {
      // Chunks only — the indexing marker and schema metadata point are not
      // chunks, and status/metrics leave them out too (bd tea-rags-mcp-39xca.12).
      const chunksCount = await this.qdrant.countPoints(collectionName, chunkPointsFilter());
      // Vector width comes from the collection, not from the provider. The
      // provider reports the static model-registry guess, which is wrong for any
      // model outside that table; register_project already stores the true width
      // read back from Qdrant, and this write must not degrade it.
      const embeddingDimensions = await this.resolveCollectionVectorSize(collectionName);
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
      // Env snapshot — the FULL effective env set of this run (canonical
      // keys, code defaults materialized), injected by the bootstrap
      // composition root from the parsed config (9vpnz). CLI index-codebase /
      // prime re-apply the map registry-first in a fresh shell with the one
      // general rule (outer env > registry env > code default).
      const { envSnapshot } = this;
      const gitState = await this.buildRegistryGitState(absolutePath);
      this.registry.record({
        collectionName,
        path: absolutePath,
        embeddingModel: this.embeddings.getModel(),
        embeddingDimensions,
        // Embedded daemon: persist the SENTINEL, never the concrete
        // http://127.0.0.1:<random-port> URL — the daemon rebinds an ephemeral
        // port per lifetime, so a frozen URL goes stale on every restart
        // (2nfdm). Consumers resolve the sentinel through daemon discovery
        // (daemon.port / spawn) at every run.
        qdrantUrl: this.qdrant.isEmbedded ? EMBEDDED_MARKER : this.qdrant.url,
        // Kept alongside the sentinel for pre-sentinel readers and display.
        qdrantEmbedded: this.qdrant.isEmbedded,
        ...(embeddingBaseUrl !== undefined ? { embeddingBaseUrl } : {}),
        ...(embeddingFallbackUrl !== undefined ? { embeddingFallbackUrl } : {}),
        // Codegraph is enabled iff the facade wired its deps (remover omitted
        // when CODEGRAPH_ENABLED is off — see RegistryDeps doc). prime reads
        // this back to re-apply the flag, symmetric with the embedding URLs.
        codegraphEnabled: this.codegraphRemover !== undefined,
        ...(envSnapshot !== undefined ? { env: envSnapshot } : {}),
        // Git state the index now represents (hpg2 auto-update watcher):
        // freshness checks compare live HEAD against this block. Absent when
        // the codebase is not a git repository.
        ...(gitState !== undefined ? { git: gitState } : {}),
        // The last run's verdict only: a run that formed no batch says nothing.
        ...(producerStarvation !== undefined && producerStarvation.formedBatches > 0
          ? { embeddingProducerStarvation: producerStarvation }
          : {}),
        indexedAt: new Date().toISOString(),
        teaRagsVersion: this.teaRagsVersion,
        chunksCount,
      });
    } catch (err) {
      process.stderr.write(`[tea-rags] registry record failed: ${(err as Error).message}\n`);
    }
  }

  /**
   * Persist the run's best measured embedding optima — already reconciled with
   * the stored ones by the tuner (bd tea-rags-mcp-cyw2r) — into the registry's
   * shared section, keyed by embedding identity: every project seeds from and
   * writes to the same records (bd tea-rags-mcp-auoxk). Each write carries the
   * stored optimum the tuner judged it against, so the registry can tell a
   * record another process landed meanwhile. An endpoint without a URL
   * (in-process provider) has no stable key. Failure is logged, never thrown —
   * like the entry itself, the optima are an out-of-band hint.
   */
  private recordThroughputOptima(throughputOptima: readonly EmbeddingEndpointThroughputOptimum[]): void {
    const writes: EmbeddingThroughputOptimumWrite[] = [];
    for (const { endpoint, optimum, storedOptimum } of throughputOptima) {
      if (endpoint.url === undefined) continue;
      writes.push({
        key: embeddingThroughputOptimumKey(endpoint.url, endpoint.model, endpoint.provider),
        optimum,
        ...(storedOptimum !== undefined ? { storedOptimum } : {}),
      });
    }
    if (writes.length === 0) return;
    try {
      this.registry?.recordEmbeddingThroughputOptima?.(writes);
    } catch (err) {
      process.stderr.write(`[tea-rags] registry throughput optima record failed: ${(err as Error).message}\n`);
    }
  }

  /**
   * Capture the repo git state for the registry entry. The dirty probes spawn
   * `git status` — acceptable at finalize (the run just scanned every file),
   * never on a query path.
   *
   * HEAD is read at the git TOPLEVEL: a project registered at a subdirectory of
   * its repository has no `.git` of its own, and stamping nothing left its
   * working-tree overlay degraded with a remedy that could not fix it (live
   * P2-2, bd tea-rags-mcp-xi2r9).
   *
   * `indexedDirtyPaths` names the indexed files this run read with content
   * `indexedCommit` does not hold (live P1-1): the overlay re-reads them, since
   * a diff against the commit stops seeing them once they are restored. Only
   * files the ingest rules admit are listed — anything else was never indexed.
   * The list is stored in full, however long; the legacy
   * `indexedDirtyPathsOverflowed` flag is never written.
   */
  private async buildRegistryGitState(absolutePath: string): Promise<RegistryGitState | undefined> {
    const state = readRepoGitState(findGitToplevel(absolutePath) ?? absolutePath);
    if (state === null) return undefined;
    const gitState: RegistryGitState = {
      indexedBranch: state.branch,
      indexedCommit: state.commit,
      indexedDirty: readWorkingTreeDirty(absolutePath),
    };
    const dirtyPaths = readWorkingTreeDirtyPaths(absolutePath);
    if (dirtyPaths === undefined) return gitState;
    const scanner = this.createScanner();
    await scanner.loadIgnorePatterns(absolutePath);
    const indexedDirtyPaths = dirtyPaths.filter((path) => scanner.accepts(path)).sort();
    return { ...gitState, indexedDirtyPaths };
  }

  // ── Processing components (private) ────────────────────

  private createChunkerPool(chunkSizeOverride?: number, projectRoot?: string): ChunkerPoolPort {
    const chunkSize = chunkSizeOverride ?? this.config.chunkSize;
    // Injected factory (tests lease warm pools, bd tea-rags-mcp-bbo1h.1) or a
    // fresh forked pool per run — the production composition injects nothing.
    const build = this.deps.createChunkerPool ?? ((poolSize, config) => new ChunkerPool(poolSize, config));
    return build(this.tuning.chunkerPoolSize, {
      chunkSize,
      chunkOverlap: this.config.chunkOverlap,
      // Hard cap = chunkSize. The chunker MUST emit chunks <= maxChunkSize so
      // they fit inside the embedding model's context window. Anything wider
      // is split by enforceMaxChunkSize before reaching the pipeline.
      maxChunkSize: chunkSize,
      // Vocabularies gated on DECLARED DEPENDENCIES — Python's frameworks and
      // Ruby's gem-gated DSL grammar (bd tea-rags-mcp-w205u.1, adx5p.1b,
      // m99j1.1.8). The ROOT travels, not the parsed set: the walk
      // needs the worker's own LanguageFactory to recognise a manifest.
      projectRoot,
    });
  }

  private createChunkPipeline(collectionName: string): ChunkPipeline {
    const throughputTuner = this.createThroughputTuner();
    return new ChunkPipeline(this.qdrant, this.embeddings, collectionName, this.deps.payloadBuilder, {
      workerPool: this.tuning.pipelineConfig.workerPool,
      accumulator: this.tuning.pipelineConfig.upsertAccumulator,
      enableHybrid: this.config.enableHybridSearch,
      ...(throughputTuner ? { throughputTuner } : {}),
    });
  }

  /**
   * One tuner per run (bd tea-rags-mcp-7ju66), bounded by the configured tuning:
   * the configured batch size is the ceiling, EMBEDDING_TUNE_MIN_BATCH_SIZE the
   * floor (ceiling/16 when unset), `embedConcurrencyCeiling` the ceiling of the
   * concurrency climb — an explicit INGEST_PIPELINE_CONCURRENCY, or
   * IMPLICIT_EMBEDDING_CONCURRENCY_CEILING when unset. It is handed the
   * registry's stored optimum for the active embedding identity: both values
   * start there (hints the bounds clamp), an aggregate record starts the run
   * settled, and the run's best point is reconciled against it before it is
   * persisted (bd tea-rags-mcp-cyw2r). Undefined when EMBEDDING_TUNE_STATIC
   * pins the static behaviour.
   */
  protected createThroughputTuner(): EmbeddingThroughputTuner | undefined {
    const { pipelineConfig } = this.tuning;
    if (pipelineConfig.adaptiveEmbedding !== true) return undefined;
    const ceiling = pipelineConfig.upsertAccumulator.batchSize;
    const { registry } = this;
    return new EmbeddingThroughputTuner({
      ceiling,
      floor: pipelineConfig.upsertAccumulator.minBatchSize ?? Math.max(1, Math.floor(ceiling / 16)),
      configuredConcurrency: pipelineConfig.embedConcurrencyCeiling ?? pipelineConfig.workerPool.concurrency,
      initialConcurrency: pipelineConfig.workerPool.concurrency,
      storedOptimum: (endpoint) =>
        endpoint.url === undefined
          ? undefined
          : registry?.readEmbeddingThroughputOptimum?.(endpoint.url, endpoint.model, endpoint.provider),
    });
  }

  /**
   * yl9tv Task 5b — whether this pipeline drives the codegraph cross-pass (chunk
   * pass feeds the input spill; worker no-ops its re-parse and drains the spill).
   * Default false (incremental `ReindexPipeline` keeps the worker's extractOneFile
   * path — no incremental-codegraph regression). The full-index `IndexPipeline`
   * overrides to enable it when a provider accepts extractions (codegraph on).
   * Single source of truth for BOTH the `beginRun` flag AND the `onFileExtraction`
   * wiring in `processAndTrack`, so the two never diverge.
   */
  protected crossPassExtractionEnabled(): boolean {
    return false;
  }

  /**
   * The spec of this pipeline's enrichment run (bd tea-rags-mcp-xpmwg,
   * 39xca.3). The base answer is an incremental reindex, a `subset`: it walks
   * only what changed, and must never let codegraph report that batch as the
   * corpus. The full-index `IndexPipeline` overrides it.
   */
  protected enrichmentRunSpec(input: StreamedEnrichmentRunInput): EnrichmentRunSpec {
    return reindexRunSpec(input);
  }

  private setupEnrichmentHooks(
    chunkPipeline: ChunkPipeline,
    input: StreamedEnrichmentRunInput & { ignoreFilter: Ignore },
  ): EnrichmentRunHandle {
    const run = this.enrichment.beginRun(this.enrichmentRunSpec(input));
    chunkPipeline.setOnBatchUpserted((items) => {
      this.enrichment.onChunksStored(run, items);
    });
    return run;
  }

  // ── Teardown ─────────────────────────────────────────────

  private async flushAndShutdown(chunkPipeline: ChunkPipeline, chunkerPool: ChunkerPoolPort): Promise<void> {
    await chunkPipeline.flush();
    await Promise.all([chunkPipeline.shutdown(), chunkerPool.shutdown()]);
  }

  /**
   * Starts background enrichment and returns a status getter.
   * Call the returned function after snapshot/finalization to get current status.
   */
  private startEnrichment(
    chunkMap: Map<string, ChunkLookupEntry[]>,
    run: EnrichmentRunHandle,
  ): () => EnrichmentStatusResult {
    if (chunkMap.size === 0) {
      // Prefetch may have set marker to "in_progress" — drain through awaitCompletion
      // which writes the final file/chunk markers (status=completed when no work).
      this.enrichment.awaitCompletion(run).catch(() => {});
      return () => ({ status: "skipped" });
    }

    let done = false;
    let enrichmentMetrics: EnrichmentMetrics | undefined;
    this.enrichment.startChunkEnrichment(run, chunkMap);
    this.enrichment
      .awaitCompletion(run)
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
