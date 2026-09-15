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
import type { CodegraphPass1FileAggregates, FileExtraction } from "./codegraph.js";
import type { CommitDiffMemoPort } from "./commit-diff-memo.js";
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
  /**
   * Run-scoped git object reader shared across every per-batch chunk-signal
   * call of one indexing run. Structural shape of `CatFileBatchReader`
   * (`core/adapters/vcs/git/git-cli/client.ts`) — declared by value here, not imported,
   * because contracts is pure (no `core/` deps per domain-boundaries.md).
   *
   * When present, the git walk reuses this ONE `git cat-file --batch` process
   * (pack opened once) instead of spawning a fresh one per batch, and does NOT
   * close it — the CALLER owns the lifecycle (ChunkPhase opens it lazily for
   * the run and closes it at drain). Absent ⇒ the walk spawns and closes its
   * own per-call reader (recovery / one-off paths). Providers that don't read
   * git objects (codegraph) ignore it. See `.claude/rules/git-cat-file-batch.md`
   * and tea-rags-mcp-kc93.
   */
  blobReader?: { read: (commitOid: string, filepath: string) => Promise<string>; close: () => Promise<void> };
  /**
   * Run-scoped (commitSha, filePath) → diff-hunks memo shared across every
   * per-batch chunk-signal call of one indexing run (bd tea-rags-mcp-7gnre).
   * Structural shape of `CommitDiffMemo` (`core/infra/commit-diff-memo.ts`) —
   * declared by value here, not imported, because contracts is pure.
   *
   * The same sweep commits are walked by many per-batch calls; the memo caps
   * the re-diff cost (2 blob reads + structuredPatch) at one diff per
   * (commit, file) per run. The concrete class bounds memory via an LRU cap
   * (~50k entries — see commit-diff-memo.ts). The CALLER owns the lifecycle:
   * ChunkPhase creates it lazily per run and drops it at drain. Providers
   * that don't diff git objects (codegraph) ignore it.
   */
  diffMemo?: CommitDiffMemoPort;
  /**
   * Run-scoped commitSha → changedFiles matrix + ONE shared bugFixShaSet
   * (bd tea-rags-mcp-82va1). Structural shape of `GitCommitDiscovery`
   * (`domains/trajectory/git/infra/commit-discovery.ts`) — declared by value
   * here, not imported, because contracts is pure.
   *
   * ONE repo-wide `git log --since --numstat` per indexing run replaces the
   * per-batch pathspec logs: each per-batch chunk walk slices the matrix
   * in-memory via `commitsForFiles` and consumes the shared bug-fix set via
   * `getBugFixShas`. The CALLER (ChunkPhase) owns the lifecycle — lazy create
   * at first chunk dispatch, drop at drain. Providers that don't walk git
   * history (codegraph) ignore it. Absent ⇒ per-batch pathspec discovery
   * (recovery / backfill paths).
   */
  commitDiscovery?: {
    commitsForFiles: (filePaths: string[]) => Promise<
      {
        commit: {
          sha: string;
          author: string;
          authorEmail: string;
          timestamp: number;
          body: string;
          parents: string[];
        };
        changedFiles: string[];
      }[]
    >;
    getBugFixShas: () => Promise<Set<string>>;
  };
  /**
   * Run-scoped off-thread chunk-churn walk thread (bd tea-rags-mcp-iqpuu).
   * Main-side handle to a dedicated worker thread that owns the whole walk
   * pipeline (commit iteration + cat-file reader + diff memo), so the
   * per-commit await chains leave the ingest main thread (the measured
   * cause of hold inflation 120ms->1.2s and embed-call inflation ~2x).
   * The job/outcome shapes are the git domain's ChunkChurnWalk* protocol
   * types (domains/trajectory/git/infra/churn-walk/protocol.ts) — declared
   * opaque here (contracts is pure); ingest only needs close(). The CALLER
   * (ChunkPhase) owns the lifecycle: lazy create at first chunk dispatch via
   * the provider's createChunkChurnWalkThread hook, closed at drain.
   */
  churnWalkThread?: {
    walk: (job: never) => Promise<unknown>;
    close: () => Promise<void>;
  };
  /**
   * Per-walk instrumentation callback (bd tea-rags-mcp-iqpuu). Invoked once
   * per chunk-churn walk with counter snapshot; ChunkPhase binds it to the
   * pipeline debug log ([ChunkChurn] line + chunkChurn stage time). Never
   * serialized: attached only on inline/main-thread dispatch paths.
   */
  onWalkStats?: (stats: {
    files: number;
    commits: number;
    holdCount: number;
    semWaitMs: number;
    blobReads: number;
    patches: number;
    memoHits: number;
    wallMs: number;
  }) => void;
}

/**
 * What part of the project an enrichment run resolved (bd tea-rags-mcp-xpmwg).
 *
 * - `wholeCorpus` — every file of the languages the run walked: a full index
 *   (`IndexPipeline`) or an enrichment recompute (`--force-enrichments`, with or
 *   without `--languages`).
 * - `subset` — only the files the run was handed: an incremental reindex, a
 *   repair-only finalize.
 *
 * A provider that persists run-level measurements must not let a `subset` run
 * speak for the corpus — codegraph's resolve breakdown did, and a one-file
 * incremental replaced a language's whole measurement with that file's calls.
 */
export type EnrichmentRunCoverage = "wholeCorpus" | "subset";

/**
 * Options for buildFileSignals — symmetric to ChunkSignalOptions but the
 * shape is simpler (no concurrency / cache concerns at file level today).
 * Carries the active collection name so collection-scoped providers
 * (codegraph) can pick their per-collection store before walking files.
 */
export interface FileSignalOptions {
  /** Optional path subset for backfill / incremental reindex callers. */
  paths?: string[];
  /**
   * Per-file SHA256 for the run, keyed by repo-relative path
   * (bd tea-rags-mcp-6goqa). A provider that keeps a per-file store persists
   * the hash alongside each row, so a later run can tell a row that is merely
   * PRESENT from one that is CURRENT — which is what the repair check diffs.
   *
   * Sourced from the ingest snapshot, so there is one definition of the hash
   * and no extra read. Absent in direct/test callers; a row written without it
   * persists a NULL hash and will be re-extracted, never silently assumed
   * current. Survives the worker-pool `structuredClone` boundary as a Map.
   */
  contentHashes?: ReadonlyMap<string, string>;
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
  /**
   * yl9tv Task 5b — run-level cross-pass flag. TRUE only on the full-index path
   * when the ingest chunk pass feeds each file's codegraph `FileExtraction` into
   * the provider's input spill (via `acceptExtraction`). The flag is sourced
   * from the PIPELINE (full index sets it; `reindex_changes` never does), NOT
   * from provider capability — see `coordinator.beginRun` threading.
   *
   * Codegraph reads it on BOTH worker entry points: `streamFileBatch` no-ops the
   * main/worker re-parse (the spill is already populated from the chunker's
   * single parse), and `finalizeSignals` drains the input spill instead. Other
   * providers (git) ignore it. Primitive boolean — survives the worker-pool
   * `structuredClone` boundary intact.
   */
  crossPass?: boolean;
  /**
   * How much of the project this run resolved (bd tea-rags-mcp-xpmwg) — see
   * {@link EnrichmentRunCoverage}. Set by the enrichment coordinator on every
   * finalize it dispatches; absent only for direct callers outside the ingest
   * pipeline (tests, offline harnesses), which hand the provider the corpus they
   * mean to measure. Primitive string — survives the worker-pool
   * `structuredClone` boundary.
   */
  runCoverage?: EnrichmentRunCoverage;
  /**
   * The run's persisted per-file pass-1 aggregate slices, read by the MAIN
   * thread and injected into the provider's finalize (bd tea-rags-mcp-weno4).
   *
   * znxg8 made the pass-1→pass-2 barrier hydrate its run-global registries from
   * these rows for every file the run did not walk. Reading them inside the
   * codegraph WORKER cannot be relied on: that thread's `GraphDbClientPool` is
   * built without a `daemonRestart` hook, so it tolerates a daemon compiled from
   * other source — one that answers `unknown daemon op: listAllPass1Aggregates`
   * and silently degrades the repair back to a batch-scoped registry. The main
   * thread's pool DOES respawn a stale daemon, so it reads the rows (via
   * {@link EnrichmentProvider.readPersistedPass1Aggregates}) and hands them
   * across on this option.
   *
   * Injected rows WIN over the provider's own read; the read stays as the
   * fallback for direct/test callers, where there is no daemon. Plain data —
   * survives the worker-pool `structuredClone` boundary. Providers that keep no
   * pass-1 store (git) ignore it.
   */
  pass1Aggregates?: readonly CodegraphPass1FileAggregates[];
  /** Per-blame-pass instrumentation (bd tea-rags-mcp-v2mlw): invoked once per
   *  populateBlameMap pass with cache hit/miss counters and wall duration;
   *  the file phase binds it to the pipeline debug log ([GitEnrich] BLAME
   *  line + "blame" stage). Never serialized: attached only on inline /
   *  main-thread dispatch paths (precedent: onWalkStats). */
  onBlameStats?: (stats: { files: number; hits: number; misses: number; durationMs: number }) => void;
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
   * Used by codegraph (symbolTable/chunkSymbolByLine). Git does NOT use this —
   * git runs inline (no workerDescriptor) so its blameByRelPath/enrichmentCache
   * are reused automatically on the main-thread instance.
   */
  dispatch: "stateless" | "collection-affinity";
  /**
   * Opt in to pass-1 EXTRACTION fan-out: the executor may split a file batch
   * across the workers this provider's affinity binding leaves idle, calling
   * `extractFileBatch` on each and handing the records to the pinned worker's
   * `absorbExtractedFiles`. Only meaningful together with
   * `dispatch: "collection-affinity"` — a stateless provider already spreads.
   *
   * Declaring it asserts that `extractFileBatch` is PURE per file: no store
   * write, no run-global accumulation, nothing the pinned worker owns. The
   * affinity contract is otherwise untouched — absorb, finalize, deferred
   * chunk work and release all stay on the one pinned thread.
   */
  extractionFanout?: boolean;
  /**
   * Per-provider structured-clone-safe payload. Each provider declares its
   * own typed config inside its own module; ingest treats it as opaque
   * data. For git: `GitWorkerConfig`; for codegraph: `CodegraphWorkerConfig`.
   * The factory referenced by `providerFactoryExport` is the single place
   * that interprets this payload.
   */
  serializableConfig: unknown;
}

// --- Pass-1 extraction fan-out ---

/**
 * One language's share of an extraction unit's pass-1 cost.
 *
 * `ms` is that unit's OWN wall clock — an extraction worker measures only what
 * it parsed itself, so several units' figures are concurrent, not additive.
 * The executor merges them accordingly (see `FileExtractionFanoutBatch`).
 */
export interface FileExtractionPass1Telemetry {
  /** Wall clock this unit spent parsing files of this language. */
  ms: number;
  /** Files of this language the unit produced an extraction for. */
  files: number;
}

/**
 * What one `extractFileBatch` call hands back: the serializable extraction
 * records plus the pass-1 attribution the pinned worker folds into its own
 * phase timings at absorb time (the extraction worker has no run of its own to
 * report against).
 */
export interface FileExtractionFanoutBatch {
  extractions: FileExtraction[];
  pass1ByLanguage: Record<string, FileExtractionPass1Telemetry>;
}

// --- Enrichment scope ---

/**
 * How much enrichment a provider wants for one file.
 *   "full"      — file-level AND chunk-level enrichment (default).
 *   "file-only" — file-level only; skip the expensive chunk-churn walk.
 *   "none"      — skip both. The file stays indexed/searchable; only this
 *                 provider's signals are omitted for it.
 */
export type EnrichmentScope = "full" | "file-only" | "none";

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
   * Per-file content hashes this provider has already persisted for
   * `collectionName`, as `relPath -> hash`, with `null` for a row written
   * before the provider stored hashes at all (bd tea-rags-mcp-6goqa).
   *
   * The coordinator diffs this against the run's eligible files to decide which
   * files a provider must re-extract before its store matches the code. A
   * provider that keeps no per-file store simply omits the method and the
   * repair pass skips it — git does exactly that.
   *
   * An empty map means "this provider knows nothing about this collection", so
   * a collection with no graph yet repairs everything, which is what a freshly
   * created versioned collection needs.
   */
  readPersistedFileHashes?: (collectionName: string) => Promise<Map<string, string | null>>;
  /**
   * Every persisted per-file pass-1 aggregate slice this provider holds for
   * `collectionName` (bd tea-rags-mcp-weno4). Called on the MAIN-thread provider
   * instance, whose pool respawns a stale daemon, and the result is threaded to
   * the worker's finalize as {@link FileSignalOptions.pass1Aggregates} — see
   * that field for why the worker's own read cannot be trusted to succeed.
   *
   * Optional and modelled on {@link readPersistedFileHashes}: a provider with no
   * pass-1 store omits it and the injection is simply absent, which is what git
   * does. A collection with no graph yet yields an empty list, not an error.
   */
  readPersistedPass1Aggregates?: (collectionName: string) => Promise<CodegraphPass1FileAggregates[]>;
  /**
   * Narrow repo-relative `paths` to the ones this provider's per-file store can
   * ever hold a row for (bd tea-rags-mcp-65bkl). The write-side counterpart of
   * {@link readPersistedFileHashes}, and only the repair diff consults it.
   *
   * `shouldEnrich` cannot answer this. It decides whether a POINT is owed a
   * payload block, which for codegraph is deliberately wider than the walk: a
   * `tsconfig.json` or a `README.md` comes back `"full"` and carries an all-zero
   * codegraph block, but has no `CODEGRAPH_LANGUAGES` entry, so pass-1 drops it
   * and pass-2 writes no `cg_symbols_files` row. Diffing hashes over the wider
   * set reports every such file missing on EVERY run — `repaired=482` in
   * perpetuity on taxdome — and the run can do nothing about it.
   *
   * Absent ⇒ the provider persists whatever it is asked for and the repair set
   * is the `shouldEnrich`-eligible set unchanged. Must be a pure filter: same
   * order, same strings, subset only.
   */
  filterExtractablePaths?: (paths: readonly string[]) => string[];
  /**
   * Factory for the run-scoped commit discovery (bd tea-rags-mcp-82va1) —
   * the provider owns the window config (chunkMaxAgeMonths / timeout),
   * ChunkPhase owns the instance lifecycle (lazy create at first chunk
   * dispatch, dropped at drain). Construction is synchronous; the repo-wide
   * git log inside is lazy (first `commitsForFiles` / `getBugFixShas` call).
   * Providers whose chunk signals don't walk git history omit this.
   */
  createCommitDiscovery?: (repoRoot: string) => NonNullable<ChunkSignalOptions["commitDiscovery"]>;
  /**
   * Factory for the run-scoped off-thread chunk-churn walk thread
   * (bd tea-rags-mcp-iqpuu) — the provider owns the walk implementation
   * (the thread wraps the git domain's walk pipeline), ChunkPhase owns the
   * instance lifecycle (lazy create at first chunk dispatch, closed at
   * drain). Construction is synchronous; the worker thread is spawned
   * lazily on the first walk. Providers whose chunk signals don't walk git
   * history omit this.
   */
  createChunkChurnWalkThread?: () => NonNullable<ChunkSignalOptions["churnWalkThread"]>;
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
   * Per-file enrichment policy. The coordinator classifies each file once
   * (FileClassification) and asks the provider how much enrichment it wants.
   * Absent ⇒ "full" (backward-compatible: existing providers enrich
   * everything as before). `classification` is duck-typed structurally
   * (contracts is pure — no infra import); the canonical type is
   * FileClassification in contracts/types/file-classification.ts.
   */
  shouldEnrich?: (file: {
    relPath: string;
    classification: { isSource: boolean; isGenerated: boolean; isDocumentation: boolean; isTest: boolean };
  }) => EnrichmentScope;
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
   * `releaseRun(handle)` at the end of the latest run on the collection. The provider drops per-collection in-memory state held on the
   * cached instance (codegraph: `symbolTable` / `chunkSymbolByLine` via
   * `clearRunState`; git: no-op — no cross-call state). Failures are
   * swallowed by the worker (bounded memory wins over perfect cleanup): the
   * next index pass rebuilds the provider from scratch.
   */
  readonly onRelease?: () => Promise<void>;
  /**
   * yl9tv Task 5b — cross-pass channel. When set, the ingest chunk pass tees
   * each file's codegraph `FileExtraction` (produced from the SAME worker parse
   * it chunked with) here instead of the provider re-parsing. The codegraph
   * provider SYNC-APPENDS it (root-relative `relPath`) to a DETERMINISTIC
   * per-collection input spill on disk. This runs on the MAIN-thread provider
   * instance (the coordinator calls it directly); the off-thread worker's
   * `finalizeSignals` later reads that same deterministic path (both pools share
   * `rootDir`) and drains it — the disk file IS the main→worker bridge. Providers
   * without a codegraph spill (git) omit this. Fire-and-forget by contract; the
   * provider dedups + swallows IO errors internally (best-effort spill). SYNC by
   * design (`appendFileSync`) — the bytes must be flushed before the worker's
   * finalize reads them, and the call is made directly on the main-thread
   * instance (never dispatched through the worker executor), so it returns void.
   */
  acceptExtraction?: (extraction: FileExtraction, options?: { collectionName?: string }) => void;
  /**
   * yl9tv Task 5b — truncate the per-collection input spill + reset the
   * main-side dedup set at run start. Called by `coordinator.beginRun` on the
   * MAIN-thread provider BEFORE any `acceptExtraction`, ONLY when the run is
   * cross-pass (full index). Idempotent. Providers without an input spill (git)
   * omit this.
   */
  beginExtractionRun?: (collectionName?: string) => void;
  /**
   * Cross-pass end-of-file-phase seam — mirror of `beginExtractionRun`. Called by
   * `CompletionRunner` on the MAIN-thread provider AFTER the file phase drains
   * and BEFORE the WORKER's `finalizeSignals` (`runFinalize`) is dispatched, ONLY
   * when the run is cross-pass. Flushes the MAIN instance's sub-cadence node-def
   * remainder (the `acceptExtraction` buffer's `N mod flushCadence` tail that the
   * eager batch threshold never reached) durably before pass-2 resolves edges —
   * the WORKER's own remainder flush sees only its empty buffer, so without this
   * seam the MAIN remainder is discarded by the next run's reset (dangling edges).
   * Awaited (unlike sync `beginExtractionRun`) so nodes-before-edges holds across
   * the MAIN↔WORKER instance boundary. Providers without an input spill (git) omit
   * this.
   */
  endExtractionRun?: (collectionName?: string) => Promise<void>;
  /**
   * Pass-1 fan-out, extraction half. Parse + walk `paths` and return the
   * records — nothing else. MUST be pure with respect to everything the
   * collection-pinned worker owns: no store write, no symbol-table upsert, no
   * run-global merge, no spill. That purity is what lets the executor run this
   * on ANY free worker while the pinned one keeps its accumulated run state.
   *
   * Declared together with `workerDescriptor.extractionFanout`; a provider that
   * omits either keeps the single-threaded `streamFileBatch` path.
   */
  extractFileBatch?: (root: string, paths: string[], options?: FileSignalOptions) => Promise<FileExtractionFanoutBatch>;
  /**
   * Pass-1 fan-out, absorb half — the mirror of `extractFileBatch`, and the
   * ONLY half that runs on the pinned worker. Takes records produced elsewhere
   * and performs exactly what `streamFileBatch` would have done after its own
   * parse: symbol table, durable node defs, run-global merge, spill append.
   *
   * `pass1ByLanguage` is the merged attribution of the extraction units that
   * produced these records, folded into the provider's phase timings here
   * because the pinned worker is the one that reports the run.
   */
  absorbExtractedFiles?: (
    root: string,
    extractions: FileExtraction[],
    options?: FileSignalOptions & { pass1ByLanguage?: Record<string, FileExtractionPass1Telemetry> },
  ) => Promise<void>;
}

// Re-export for convenience
export type { ChunkLookupEntry } from "./chunker.js";
