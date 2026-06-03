/**
 * Shared provider contracts — domain interfaces for trajectory system.
 * Lives in contracts/ for DIP: trajectory, ingest, search all import from here.
 *
 * EnrichmentProvider is the single interface that every trajectory provider
 * must implement. It covers both the ingest side (buildFileSignals,
 * buildChunkSignals) and the query side (signals, filters, presets).
 */

import type { Ignore } from "ignore";

import type { ChunkLookupEntry } from "./chunker.js";
import type { DerivedSignalDescriptor, RerankPreset } from "./reranker.js";
import type { PayloadSignalDescriptor } from "./trajectory.js";

/**
 * Per-provider counters reported by an enrichment provider for a single run.
 * Shape is provider-defined — coordinator stores them verbatim under
 * `EnrichmentMetrics.byProvider[providerKey]` without interpreting the keys.
 * Relocated from `core/types.ts` so contracts is self-contained.
 */
export type ProviderRunMetrics = Record<string, unknown>;

/**
 * Structural shape mirroring a Qdrant filter condition without importing from
 * adapters/ — contracts is pure (no `core/` deps) per domain-boundaries.md.
 * The strict typed version lives in `core/adapters/qdrant/types.ts`; callers
 * that need it cast at the adapter boundary.
 */
type QdrantFilterConditionShape = Record<string, unknown>;

// --- Signal overlay base types ---

/** Base type for file-level signal payload. All providers extend this. */
export interface FileSignalOverlay {
  [key: string]: unknown;
}

/** Base type for chunk-level signal payload. All providers extend this. */
export interface ChunkSignalOverlay {
  [key: string]: unknown;
}

// --- Scoring weights ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
}

// --- Filter level ---

/** Payload level for level-aware filters ("file" or "chunk"). */
export type FilterLevel = "file" | "chunk";

// --- Filter condition result ---

/** Result of converting a user param to Qdrant filter conditions. */
export interface FilterConditionResult {
  must?: QdrantFilterConditionShape[];
  must_not?: QdrantFilterConditionShape[];
}

// --- Filter descriptor ---

export interface FilterDescriptor {
  /** Parameter name exposed to users (e.g. "author", "minAgeDays") */
  param: string;
  /** Human-readable description */
  description: string;
  /** Parameter type for schema generation */
  type: "string" | "number" | "boolean" | "string[]";
  /** Convert user param value to Qdrant filter condition(s) */
  toCondition: (value: unknown, level?: FilterLevel) => FilterConditionResult;
}

// --- File signal transform ---

export type FileSignalTransform = (data: FileSignalOverlay, maxEndLine: number) => FileSignalOverlay;

// --- Payload builder ---

/** Builds the base Qdrant payload from a chunk. Injected into the pipeline. */
export interface PayloadBuilder {
  buildPayload: (
    chunk: { content: string; startLine: number; endLine: number; metadata: Record<string, unknown> },
    codebasePath: string,
  ) => Record<string, unknown>;
}

// --- Chunk signal options ---

/**
 * Options for buildChunkSignals — allows coordinator to inject shared
 * concurrency and opt out of HEAD-based caching for partial streaming calls.
 */
export interface ChunkSignalOptions {
  /**
   * External semaphore to use instead of the provider's internal concurrency
   * limiter. Lets a coordinator share one limit across many per-batch calls.
   */
  concurrencySemaphore?: { acquire: () => Promise<() => void> };
  /**
   * Skip HEAD-based caching. Required for streaming partial calls, since a
   * subset of the chunk map would corrupt the cache for the next full call.
   */
  skipCache?: boolean;
  /**
   * Active Qdrant collection name the chunks belong to. Threaded from
   * EnrichmentCoordinator.beginRun so collection-scoped providers
   * (codegraph) can route writes to their per-collection backing store
   * (per-collection DuckDB file). Optional: providers that don't care
   * about collection scope (git) ignore it.
   */
  collectionName?: string;
}

/**
 * Options for buildFileSignals — symmetric to ChunkSignalOptions but the
 * shape is simpler (no concurrency / cache concerns at file level today).
 * Carries the active collection name so collection-scoped providers
 * (codegraph) can pick their per-collection store before walking files.
 */
export interface FileSignalOptions {
  /** Optional path subset for backfill / incremental reindex callers. */
  paths?: string[];
  /** Active Qdrant collection name — see ChunkSignalOptions.collectionName. */
  collectionName?: string;
  /**
   * Shared `Ignore` instance from FileScanner — the same filter that
   * `EnrichmentCoordinator` already holds in `ProviderContext.ignoreFilter`.
   * Carries BUILTIN_IGNORE_PATTERNS + user `.gitignore` / `.contextignore`
   * rules. Providers that walk the file tree themselves (codegraph) read
   * this to stay aligned with the main ingest path's file selection.
   * Providers that don't walk the tree (git) ignore it.
   */
  ignoreFilter?: Ignore;
}

/**
 * Options for handleDeletedPaths — carries the active collection so the
 * provider routes deletion to the correct per-collection store. Optional
 * for callers that haven't been threaded yet (legacy paths fall back to
 * the provider's default routing).
 */
export interface DeletedPathOptions {
  collectionName?: string;
}

// --- Worker enrichment descriptor ---

/**
 * Per-provider declaration of how its enrichment runs on the worker pool.
 *
 * Lives on `EnrichmentProvider.workerDescriptor` (optional). The provider
 * DECLARES; the executor (`WorkerPoolEnrichmentExecutor`) DISPATCHES. Keeping
 * the descriptor data-only (no executor reference) preserves the inline ↔
 * worker swap: the provider has no idea which thread its methods run on.
 *
 * Worker DI rule (.claude/rules/domains-language.md): nothing on this object
 * may be a class instance — it crosses the `postMessage` structured-clone
 * boundary. Non-serializable deps (e.g. codegraph's `languageFactory` /
 * DuckDB pool handle) are rebuilt in-thread by the named factory export,
 * which is the SOLE place that interprets `serializableConfig`.
 */
export interface WorkerEnrichmentDescriptor {
  /** Absolute compiled-JS path; worker dynamic-imports it (DI rule). */
  providerModulePath: string;
  /**
   * Named factory export the worker calls to build the provider in-thread:
   *   `(config: <ProviderConfig>) => Promise<EnrichmentProvider>`
   * The factory itself is the rebuild seam — it does dynamic-imports of
   * non-serializable deps (language module path) and opens connections
   * (DuckDB daemon socket) inside the worker thread. The provider type
   * stays opaque to ingest; only the factory module knows its real shape.
   */
  providerFactoryExport: string;
  /**
   * `stateless` — any free worker; no routingKey; round-robin. Use only for
   * providers that carry no cross-call state (no shared caches, symbol tables,
   * or result buffers across file/chunk/finalize batches).
   * `collection-affinity` — pinned worker per `routingKey = collectionName`.
   * All file/chunk/finalize batches for the same collection land on the same
   * thread so providers can share in-process state across the ingest cycle.
   * Used by git (blameByRelPath/enrichmentCache) and codegraph
   * (symbolTable/chunkSymbolByLine).
   */
  dispatch: "stateless" | "collection-affinity";
  /**
   * Per-provider structured-clone-safe payload. Each provider declares its
   * own typed config inside its own module; ingest treats it as opaque
   * data. For git: `GitWorkerConfig`; for codegraph: `CodegraphWorkerConfig`.
   * The factory referenced by `providerFactoryExport` is the single place
   * that interprets this payload.
   */
  serializableConfig: unknown;
}

// --- Enrichment provider ---

export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;

  // ── Query-side contract ──

  /** Payload signal descriptors (raw payload field docs for MCP schema generation) */
  readonly signals: PayloadSignalDescriptor[];
  /** Derived signal descriptors for reranking (normalized transforms of raw signals) */
  readonly derivedSignals: DerivedSignalDescriptor[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: RerankPreset[];

  // ── Ingest-side contract ──

  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;
  /** Optional per-file transform applied at write time. */
  readonly fileSignalTransform?: FileSignalTransform;
  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (root: string, options?: FileSignalOptions) => Promise<Map<string, FileSignalOverlay>>;
  /** Chunk-level signal enrichment (streaming per-batch or post-flush). */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ) => Promise<Map<string, Map<string, ChunkSignalOverlay>>>;
  /**
   * Per-batch streaming file enrichment. Returns signals to apply immediately
   * for the given batch of repo-relative paths. Providers whose file signals
   * need the complete data set (codegraph graph metrics) return an empty map
   * and defer to finalizeSignals. Optional: when absent the coordinator falls
   * back to buildFileSignals({ paths: batchPaths }).
   */
  streamFileBatch?: (
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ) => Promise<Map<string, FileSignalOverlay>>;
  /**
   * Deferred whole-repo FILE finalize, run once after the embedding stream.
   * Returns FILE-level overlays that require the complete data set (e.g. graph
   * fanIn p95 / transitive impact). Optional: providers that stream everything
   * (git) omit it or return an empty map. CHUNK-level deferred signals are NOT
   * returned here — providers that defer chunk signals set
   * `defersChunkEnrichment` and the coordinator runs a separate post-finalize
   * `buildChunkSignals` pass (see codegraph-chunk-defer-design spec).
   */
  finalizeSignals?: (root: string, options?: FileSignalOptions) => Promise<Map<string, FileSignalOverlay>>;
  /**
   * When true, this provider's CHUNK signals cannot be computed per-batch —
   * they depend on the whole finalized data set (codegraph: the graph is only
   * queryable after the run sink's finish()). The coordinator skips per-batch
   * chunk dispatch for such providers and runs ONE buildChunkSignals pass after
   * the file-level finalize. Absent / false ⇒ chunk signals stream per batch
   * (git).
   */
  readonly defersChunkEnrichment?: boolean;
  /**
   * Optional per-run counters surfaced via
   * `EnrichmentMetrics.byProvider[provider.key]`. Returned shape is
   * provider-defined; coordinator stores it verbatim. Called once per
   * enrichment cycle by `CompletionRunner.run`; provider is expected to
   * reset internal counters after each call (or return values aggregated
   * since the last reset).
   */
  getRunMetrics?: () => ProviderRunMetrics | undefined;
  /**
   * Optional deletion hook — invoked by `EnrichmentCoordinator.notifyDeletions`
   * before sync removes the corresponding Qdrant points. Provider clears
   * its provider-owned state for those paths (e.g. codegraph deletes graph
   * edges + symbol-table entries; future providers might clear per-file
   * caches). Calling order is sync → coordinator → all providers →
   * qdrant.deletePoints, so if Qdrant deletion fails the provider state
   * is already consistent — preferable to the inverse: orphan graph
   * edges are silent corruption, orphan Qdrant points are just clutter.
   *
   * `paths` are repo-relative POSIX (same shape as buildFileSignals
   * `options.paths`). Provider is expected to be idempotent: receiving a
   * path it never enriched must be a no-op, not an error.
   */
  handleDeletedPaths?: (paths: string[], options?: DeletedPathOptions) => Promise<void>;
  /**
   * Worker-pool descriptor for the unified enrichment executor. Absent ⇒
   * `WorkerPoolEnrichmentExecutor` runs this provider on the main thread
   * (graceful inline fallback for providers not yet migrated). Present ⇒
   * executor dispatches calls through the pool per `dispatch` mode.
   *
   * Data-only by design: provider DECLARES, executor DISPATCHES. Provider
   * never references `EnrichmentExecutor` or `WorkerPool`, so the inline ↔
   * worker swap stays transparent. See `.claude/rules/domains-language.md`
   * (worker DI via module-path injection).
   */
  readonly workerDescriptor?: WorkerEnrichmentDescriptor;
  /**
   * Optional release hook the worker calls when the executor signals
   * `releaseCollection(name)` after `EnrichmentCoordinator.awaitCompletion`
   * resolves. The provider drops per-collection in-memory state held on the
   * cached instance (codegraph: `symbolTable` / `chunkSymbolByLine` via
   * `clearRunState`; git: no-op — no cross-call state). Failures are
   * swallowed by the worker (bounded memory wins over perfect cleanup): the
   * next index pass rebuilds the provider from scratch.
   */
  readonly onRelease?: () => Promise<void>;
}

// Re-export for convenience
export type { ChunkLookupEntry } from "./chunker.js";
