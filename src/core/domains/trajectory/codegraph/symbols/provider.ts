/**
 * Codegraph symbols `EnrichmentProvider`: bridges walker output
 * (`FileExtraction`) and the graph DB (`GraphDbClient`), and owns the run
 * lifecycle that ties the three seams together:
 *
 *   - extraction (`file-extractor.ts`): pass-1 entry points (`streamFileBatch`,
 *     the fan-out's `absorbExtractedFiles`, cross-pass `acceptExtraction`) feed
 *     the run's extraction sink; its `finish` resolves pass-2 edges.
 *   - finalize (`run-finalize.ts`): `finalizeSignals` / `buildFileSignals` read
 *     file overlays (fanIn / fanOut / instability / isHub / isLeaf /
 *     transitiveImpact) off the finished graph and persist the resolve tally.
 *   - chunk signals (`chunk-signal-pass.ts`): `buildChunkSignals`, the deferred
 *     pass, settles each stored chunk through `settleCodegraphChunkSignals`.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname as pathDirname } from "node:path";

import type { Ignore } from "ignore";

import type { GraphDbClientPool } from "../../../../adapters/duckdb/pool.js";
import type {
  CodegraphPass1FileAggregates,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  SymbolDefinition,
  SymbolLineRange,
} from "../../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import type { FileClassification } from "../../../../contracts/types/file-classification.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../../contracts/types/language.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOptions,
  ChunkSignalOverlay,
  DeletedPathOptions,
  EnrichmentProvider,
  EnrichmentRunCoverage,
  EnrichmentScope,
  FileExtractionAbsorbRole,
  FileExtractionFanoutBatch,
  FileExtractionPass1Telemetry,
  FileSignalOptions,
  FileSignalOverlay,
  FilterDescriptor,
  ProviderRunMetrics,
  WorkerEnrichmentDescriptor,
} from "../../../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../../../contracts/types/reranker.js";
import { collectDependencyManifestSources } from "../../../../infra/dependency-manifests.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  buildCodegraphExclusionFilter,
  collectSchemaColumnSources,
  type CodegraphExclusionOptions,
} from "../exclusion.js";
import { CodegraphChunkSignalPass } from "./chunk-signal-pass.js";
import {
  createCodegraphExtractionSink,
  recomputeCodegraphMetricsBestEffort,
  type CodegraphExtractionSink,
  type CodegraphSinkDeps,
} from "./extraction-sink.js";
import { CodegraphFileExtractor } from "./file-extractor.js";
import { GraphBuildFinalizer } from "./graph-finalizer.js";
import { SymbolNodeFlushQueue } from "./node-flush.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";
import { CodegraphPhaseTimings } from "./phase-timings.js";
import { CallEdgeResolutionRunner } from "./resolution-runner.js";
import { drainCrossPassInputSpill, persistRunResolveStats, readCodegraphFileOverlays } from "./run-finalize.js";
import { CodegraphRunState } from "./run-state.js";
import { lastSegment } from "./symbol-name.js";

/**
 * Relocated collaborators, re-exported for import stability: the symbols barrel,
 * scripts and tests import these names from `provider.js`.
 */
export { CODEGRAPH_LANGUAGES, type CodegraphLanguageConfig } from "./file-extractor.js";
export { computeSymbolChunkIds } from "./chunk-signal-pass.js";

/**
 * Strip one `_v<digits>` versioning suffix from a collection name
 * (`code_x_v6` → `code_x`); any other shape is returned unchanged. No production
 * caller: the graph DB is addressed by the PHYSICAL versioned name (see
 * `getStore`), and the helper stays exported for `provider-pool-routing.test.ts`.
 */
export function stripVersionSuffix(collectionName: string): string {
  return collectionName.replace(/_v\d+$/, "");
}

/**
 * Codegraph provider dependencies. Exactly one routing mode MUST be supplied:
 *
 *   - **Pool mode (production).** `pool` is the per-collection
 *     `GraphDbClientPool`; every call resolves its store from
 *     `options.collectionName` (`wireCodegraph` in `src/bootstrap/factory.ts`).
 *   - **Direct mode (tests).** `graphDb` + `symbolTable` are one pre-opened pair
 *     used for every call; `collectionName` is ignored.
 *
 * Supplying both, or neither, throws at construction.
 */
export interface CodegraphProviderDeps {
  /** Pool mode — per-collection DuckDB files routed via collectionName. */
  pool?: GraphDbClientPool;
  /** Direct mode — pre-opened graph client. Mutually exclusive with `pool`. */
  graphDb?: GraphDbClient;
  /** Direct mode — pre-built symbol table. Mutually exclusive with `pool`. */
  symbolTable?: GlobalSymbolTable;
  /**
   * Per-language walker + resolver source, injected from the composition layer.
   * The provider reads `factory.create(lang).walker` for pass-1 and `.resolver`
   * for pass-2; the concrete factory is never imported here (leaf-domain guard:
   * `trajectory/** -> domains/language/**` is forbidden). bd tea-rags-mcp-cat4.
   */
  languageFactory: LanguageFactoryDescriptor;
  /**
   * Cross-language symbolId mapper passed to `collectSymbols` to compose ids per
   * `.claude/rules/symbolid-convention.md`; injected as the contracts interface for
   * the same leaf-domain reason.
   */
  composer: SymbolIdComposer;
  /**
   * Symbol-range collector (yl9tv), a `domains/language/kernel` function injected
   * for the same reason. The chunker worker loads the SAME function through its
   * `languageModulePath`, so one parse can feed both the chunks and the extraction.
   */
  collectSymbols: CollectSymbolsFn;
  /** Derived signals + presets, wired by `createSymbolsTrajectory`. */
  derivedSignals?: DerivedSignalDescriptor[];
  presets?: RerankPreset[];
  /**
   * Codegraph-layer exclusion config — wired from
   * `codegraphSchema.customExcludePatterns` by the bootstrap factory.
   * Optional: tests/fixtures default to `{ customPatterns: [] }`, which still
   * carries the unconditional generated + test exclusions, so a fixture
   * behaves like production without env wiring.
   */
  exclusion?: CodegraphExclusionOptions;
}

/**
 * Reverse include-by index — re-exported for import stability (bd cai0/2oky5).
 * The implementation lives in `run-state.ts` beside the ancestor maps it
 * inverts; importing it from there here would make `run-state.ts` import its
 * own consumer.
 */
export { buildIncludedBy } from "./run-state.js";

export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[] = [];
  readonly presets: RerankPreset[];

  /**
   * Chunk signals (fanIn / fanOut / pageRank) read the DuckDB graph, which exists
   * only once the run sink's `finish` resolves — per-batch reads would see an
   * empty graph. The coordinator therefore runs ONE `buildChunkSignals` pass after
   * this provider's `finalizeSignals`.
   */
  readonly defersChunkEnrichment = true;

  /**
   * Chunks are settled explicitly (bd tea-rags-mcp-39xca.2): `buildChunkSignals`
   * returns an overlay — empty when there are no signal values — for every chunk
   * it settles, and leaves out only the chunks it could not, which callers must
   * therefore not stamp. The settlement itself is `chunk-signal-settlement.ts`.
   */
  readonly settlesChunksExplicitly = true;

  /**
   * Per-collection `relPath → walked symbol line ranges`, written by every pass-1
   * walk and read by the deferred `buildChunkSignals` pass — the input of the
   * chunk-owner rule (bd tea-rags-mcp-9i2ow). Keyed by collection (`__direct__`
   * in direct mode) because one provider instance serves every collection of the
   * process, and two repos can share a relPath. Shared by reference with
   * `chunkSignalPass`; the run lifecycle here resets, prunes and clears it.
   */
  private readonly chunkSymbolByLine = new Map<string, Map<string, SymbolLineRange[]>>();
  /**
   * Active streaming extraction sink per collection key. Created lazily by the
   * first pass-1 writer, finished + consumed + deleted by `finalizeSignals`, so
   * streamed batches accumulate into one graph build.
   */
  private readonly runSinks = new Map<string, CodegraphExtractionSink>();
  /**
   * Repo-relative paths extracted via `streamFileBatch` per collection key.
   * `finalizeSignals` reads back file overlays for exactly these paths when the
   * caller doesn't pass an explicit `options.paths` subset.
   */
  private readonly runExtractedPaths = new Map<string, Set<string>>();
  /**
   * Per-collection serialization tail for `streamFileBatch` (bd tea-rags-mcp-svhqp
   * layer 3): the file phase fires batches without awaiting, and the shared spill
   * stream + `extracted` dedup are check-then-add (TOCTOU) under concurrency.
   * Settled-tolerant: a rejected batch does not poison the chain. Cleared per key
   * in `finalizeSignals` / `onRelease`.
   */
  private readonly runBatchChains = new Map<string, Promise<unknown>>();
  /**
   * yl9tv Task 5b — MAIN-thread per-collection dedup set for cross-pass input
   * spill writes, so a file whose chunks span several processing units is spilled
   * once. Reset per collection in `beginExtractionRun`. NOT the worker-side parse
   * gate — that is `options.crossPass`, which survives the structured-clone
   * boundary an in-process Set would not.
   */
  private readonly xpassWritten = new Map<string, Set<string>>();
  /**
   * Eager batched `cg_symbols` upsert during embedding, shared by both node-write
   * entry points (`acceptExtraction` and the extraction sink's `write`) so the
   * write leaves the post-embedding finalize tail. Reset with the run-global maps
   * at each run-reset seam.
   */
  private readonly nodeFlush = new SymbolNodeFlushQueue(
    async (collectionName) => this.getStore(collectionName),
    nodeFlushFilesFromEnv(),
  );
  /**
   * Pass-2 per-file call resolution (bd tea-rags-mcp-6vfrj / G2): reads the
   * run-global maps pass-1 filled and emits one file's `GraphEdges`, tallying into
   * `runState.stats`. Assigned in the constructor — a field initializer cannot read
   * the `deps` parameter property.
   */
  private readonly resolutionRunner: CallEdgeResolutionRunner;
  /**
   * Pass-2 completion (bd tea-rags-mcp-6vfrj / G2): the streaming spill →
   * resolve → bulk-upsert → checkpoint loop, plus the SCC / PageRank recompute.
   * Assigned in the constructor because it depends on `resolutionRunner`.
   */
  private readonly graphFinalizer: GraphBuildFinalizer;
  /**
   * Per-run aggregates + resolve tally (bd tea-rags-mcp-6vfrj / G2): every
   * run-global map pass-1 merges into and pass-2 reads, plus the metrics drain and
   * reset seams. Built with the languages' schema-column and dependency-manifest
   * sources, collected ONCE here because `factory.create` is expensive.
   */
  private readonly runState: CodegraphRunState;
  /**
   * Codegraph-layer ignore filter, built once from `deps.exclusion` plus each
   * language's own non-app-code globs (bd tea-rags-mcp-biwbq — e.g. Ruby's
   * `db/migrate/**`). Never empty: the generated + test patterns are
   * unconditional. The extractor and the chunk pass hold this same instance.
   */
  private readonly codegraphExclusionFilter: Ignore;
  /**
   * Wall-clock attribution across pass-1 and pass-2 (bd tea-rags-mcp-6aytq). Owned
   * here, not by the finalizer, because pass-1 runs on this side and both halves
   * land in ONE summary. Lifetime is one (collection, run) pair in the pool, so no
   * reset seam is needed.
   */
  private readonly phaseTimings = new CodegraphPhaseTimings();
  /** Pass-1 extraction seam: parse + walk, discovery, extractability, pass-1 progress. */
  private readonly fileExtractor: CodegraphFileExtractor;
  /** Chunk-signals seam: the deferred chunk pass over `chunkSymbolByLine`. */
  private readonly chunkSignalPass: CodegraphChunkSignalPass;

  /**
   * Worker-pool descriptor, set when the composition root wires this provider for
   * `WorkerPoolEnrichmentExecutor`. Undefined for inline callers (tests, the
   * inline executor), which call the provider in-thread.
   */
  readonly workerDescriptor?: WorkerEnrichmentDescriptor;

  constructor(
    private readonly deps: CodegraphProviderDeps,
    workerDescriptor?: WorkerEnrichmentDescriptor,
  ) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
    this.workerDescriptor = workerDescriptor;
    this.runState = new CodegraphRunState(
      collectSchemaColumnSources(deps.languageFactory),
      collectDependencyManifestSources(deps.languageFactory),
    );
    this.resolutionRunner = new CallEdgeResolutionRunner(deps.languageFactory, this.runState);
    this.graphFinalizer = new GraphBuildFinalizer(
      async (collectionName) => this.getStore(collectionName),
      this.resolutionRunner,
      this.runState,
      this.phaseTimings,
    );
    this.codegraphExclusionFilter = buildCodegraphExclusionFilter(
      deps.exclusion ?? { customPatterns: [] },
      deps.languageFactory,
    );
    this.fileExtractor = new CodegraphFileExtractor({
      languageFactory: deps.languageFactory,
      collectSymbols: deps.collectSymbols,
      composer: deps.composer,
      runState: this.runState,
      phaseTimings: this.phaseTimings,
      exclusionFilter: this.codegraphExclusionFilter,
    });
    this.chunkSignalPass = new CodegraphChunkSignalPass(this.chunkSymbolByLine, this.codegraphExclusionFilter);
    // Configuration invariant: exactly one routing mode must be picked
    // at construction. We accept either `pool` OR (`graphDb`+`symbolTable`),
    // never both, never neither — silent fallback would mask wiring bugs
    // in tests and bootstrap alike.
    const hasDirect = deps.graphDb !== undefined && deps.symbolTable !== undefined;
    const hasPool = deps.pool !== undefined;
    if (hasPool && hasDirect) {
      throw new Error("CodegraphEnrichmentProvider: deps.pool and deps.graphDb/symbolTable are mutually exclusive");
    }
    if (!hasPool && !hasDirect) {
      throw new Error("CodegraphEnrichmentProvider: must provide either deps.pool OR deps.graphDb + deps.symbolTable");
    }
  }

  resolveRoot(absolutePath: string): string {
    return absolutePath;
  }

  /**
   * Codegraph policy — ONE source of truth for "is this path in scope", shared
   * with the graph walk (bd tea-rags-mcp-5ikhf): `codegraphExclusionFilter` is the
   * same instance every pass-1 entry point consults.
   *
   * The two must agree. A path the walk drops never receives
   * `codegraph.symbols.<level>.enrichedAt` (no overlay, and a deferring provider
   * is skipped by backfill), so reporting it "full" strands it in recovery with a
   * `degraded` marker on every run; declining lets it be stamped `skippedAs` once.
   *
   * `isGenerated` stays a separate check: the classifier also sees
   * `TEA_RAGS_GENERATED_PATTERNS` and in-file `@generated` markers a glob cannot.
   * `isTest` needs none — filter and classifier share the constant. Docs enrich
   * fully (no chunk graph is emitted for them anyway).
   */
  shouldEnrich(file: { relPath: string; classification: FileClassification }): EnrichmentScope {
    if (file.classification.isGenerated) return "none";
    if (this.codegraphExclusionFilter.ignores(file.relPath)) return "none";
    return "full";
  }

  /**
   * Repair-diff scope: of the run's eligible files, the ones this graph can
   * actually persist a row for. Without it the diff asks for every JSON/Markdown
   * /YAML file the index carries, on every run, forever — they can never acquire
   * the row it looks for (bd tea-rags-mcp-65bkl).
   */
  filterExtractablePaths(paths: readonly string[]): string[] {
    return paths.filter((p) => this.fileExtractor.isExtractable(p));
  }

  /**
   * What this graph currently believes about each file: `relPath -> content
   * hash`, `null` where the row predates the hash column (bd tea-rags-mcp-6goqa).
   * Read through the pool's READ handle (daemon-backed in production, where a
   * cross-process READ_ONLY attach would throw). A collection with no graph yet
   * yields an empty map — the fresh-`_vN` case, where every file needs extracting.
   */
  async readPersistedFileHashes(collectionName: PhysicalCollectionName): Promise<Map<string, string | null>> {
    const hashes = new Map<string, string | null>();
    if (!this.deps.pool) {
      const rows = await (this.deps.graphDb as GraphDbClient).listFileContentHashes();
      for (const row of rows) hashes.set(row.relPath, row.contentHash);
      return hashes;
    }
    let handle;
    try {
      handle = await this.deps.pool.acquireReader(collectionName);
    } catch {
      // No DuckDB file for this collection yet — nothing persisted.
      return hashes;
    }
    try {
      for (const row of await handle.graphDb.listFileContentHashes()) {
        hashes.set(row.relPath, row.contentHash);
      }
    } finally {
      await handle.graphDb.close();
    }
    return hashes;
  }

  /**
   * Every persisted per-file pass-1 aggregate slice for `collectionName` (bd
   * tea-rags-mcp-weno4), read on the MAIN thread and injected into the worker's
   * finalize as `FileSignalOptions.pass1Aggregates`. The main pool replaces a
   * daemon from another build or lacking a required op; the worker pool has no
   * respawn hook and, since bd tea-rags-mcp-39xca.4, refuses such a daemon with
   * `CodegraphDaemonBuildSkewError` (`listAllPass1Aggregates` is required).
   * Same store resolution as every other call (`getStore`).
   */
  async readPersistedPass1Aggregates(collectionName: PhysicalCollectionName): Promise<CodegraphPass1FileAggregates[]> {
    return (await this.getStore(collectionName)).graphDb.listAllPass1Aggregates();
  }

  /**
   * Resolve the (graphDb, symbolTable) pair for the active call: the
   * per-collection pool handle in pool mode, the constructor pair in direct mode.
   * Pool mode without `collectionName` throws — a broken call surface must fail at
   * the wire-up boundary, not write rows to the wrong DB.
   */
  private async getStore(collectionName?: PhysicalCollectionName): Promise<{
    graphDb: GraphDbClient;
    symbolTable: GlobalSymbolTable;
  }> {
    if (this.deps.pool) {
      if (!collectionName) {
        throw new Error(
          "CodegraphEnrichmentProvider: pool mode requires options.collectionName — caller did not thread it through",
        );
      }
      // The FULL versioned name (no strip): writes and reads must open the same
      // per-version DuckDB file (`acquireWrite` is daemon-backed when configured).
      return this.deps.pool.acquireWrite(collectionName);
    }
    // Direct mode — both fields validated in the constructor.
    return {
      graphDb: this.deps.graphDb as GraphDbClient,
      symbolTable: this.deps.symbolTable as GlobalSymbolTable,
    };
  }

  /**
   * Drop codegraph state for files that no longer exist on disk. Called by
   * `EnrichmentCoordinator#notifyDeletions` before sync prunes the Qdrant points,
   * keeping `cg_symbols_edges_*` consistent with the file set. Idempotent: every
   * store below tolerates an unknown path.
   */
  async handleDeletedPaths(paths: string[], options?: DeletedPathOptions): Promise<void> {
    if (paths.length === 0) return;
    const { graphDb, symbolTable } = await this.getStore(options?.collectionName);
    const perColl = this.chunkSymbolByLine.get(this.collectionKey(options?.collectionName));
    for (const relPath of paths) {
      // `removeFile` clears edges AND cg_symbols rows; `removeSymbolsForFile` is
      // idempotent for symbol-only callers, so calling both is safe.
      await graphDb.removeFile(relPath);
      await graphDb.removeSymbolsForFile(relPath);
      symbolTable.removeFile(relPath);
      perColl?.delete(relPath);
    }
  }

  /**
   * Map a file's `FileExtraction` chunks to `SymbolDefinition[]` — the SINGLE
   * source of the def shape, used by both the sink's `write` and
   * `acceptExtraction`'s eager buffer so the two node-write paths cannot drift.
   */
  private buildSymbolDefs(extraction: FileExtraction): SymbolDefinition[] {
    return extraction.chunks.map((c) => ({
      symbolId: c.symbolId,
      fqName: c.symbolId,
      shortName: lastSegment(c.symbolId),
      relPath: extraction.relPath,
      scope: c.scope,
      // Thread walker-captured arity + visibility into SymbolDefinition (bd xlnub)
      ...(c.arity !== undefined ? { arity: c.arity } : {}),
      ...(c.visibility !== undefined ? { visibility: c.visibility } : {}),
      // Thread walker-captured kwarg signature + block-acceptance (bd d9o7o)
      ...(c.kwargs !== undefined ? { kwargs: c.kwargs } : {}),
      ...(c.acceptsBlock !== undefined ? { acceptsBlock: c.acceptsBlock } : {}),
      // Abstract-stub marker (bd tea-rags-mcp-bcdfe) — set only when true, so the
      // self-dispatch probe can tell a declaration from a concrete definition.
      ...(c.isAbstractStub === true ? { isAbstractStub: true } : {}),
      // The symbol's AST range, persisted so the payload healer maps chunks to
      // owners by the same rule the deferred pass uses (bd tea-rags-mcp-9i2ow).
      ...(c.startLine !== undefined && c.endLine !== undefined ? { startLine: c.startLine, endLine: c.endLine } : {}),
    }));
  }

  /**
   * Build an `ExtractionSink` bound to the active collection (optional in direct
   * mode, required in pool mode — store resolution fails loud otherwise).
   * `skipDurableNodeWrite` keeps the in-memory table, line map and run-globals but
   * skips the durable `cg_symbols` write already issued by the eager flush
   * (`drainInputSpill` passes true).
   */
  asExtractionSink(collectionName?: PhysicalCollectionName, skipDurableNodeWrite = false): CodegraphExtractionSink {
    return createCodegraphExtractionSink(this.sinkDeps, randomUUID(), collectionName, skipDurableNodeWrite);
  }

  /**
   * Collaborator wiring for the extraction sink. The pass-2 stages are passed as
   * thunks that re-read `this` at call time, so the provider stays the single
   * place deciding how pass-2 is dispatched.
   */
  private get sinkDeps(): CodegraphSinkDeps {
    return {
      resolveSymbolTable: async (collectionName) => (await this.getStore(collectionName)).symbolTable,
      // Injected rows WIN (bd tea-rags-mcp-weno4): `finalizeSignals` stashes what
      // the MAIN thread read, so a pipeline finalize never needs the barrier's own
      // read. The read is the fallback for direct/test callers.
      loadPersistedPass1Aggregates: async (collectionName) =>
        this.runState.injectedPass1Aggregates
          ? [...this.runState.injectedPass1Aggregates]
          : (await this.getStore(collectionName)).graphDb.listAllPass1Aggregates(),
      runState: this.runState,
      nodeFlush: this.nodeFlush,
      buildSymbolDefs: (extraction) => this.buildSymbolDefs(extraction),
      indexChunkSymbolsByLine: (collectionName, extraction) => {
        this.chunkSignalPass.recordWalkRanges(this.collectionKey(collectionName), extraction);
      },
      collectionKey: (collectionName) => this.collectionKey(collectionName),
      spillPathFor: (collectionName, runId) =>
        this.deps.pool
          ? this.deps.pool.spillPathFor(collectionName ?? "__direct__", runId)
          : // Direct mode (tests) has no pool — keep the spill colocated with
            // the test's working directory under a hidden subdir to avoid
            // polluting the project root.
            join(process.cwd(), ".tea-rags-codegraph-spill", `direct-${runId}.ndjson`),
      resolveAndUpsert: async (spillPath, collectionName) => this.streamingResolveAndUpsert(spillPath, collectionName),
      recomputeMetrics: async (collectionName) => this.recomputeGraphMetricsStreaming(collectionName),
    };
  }

  /**
   * Pass-2 over the NDJSON spill (`GraphBuildFinalizer#resolveAndUpsert`): resolve
   * each line against the complete symbol table, bulk-upsert, checkpoint on a
   * cadence. O(1) memory in the spill size — one JSON line resident at a time.
   */
  private async streamingResolveAndUpsert(spillPath: string, collectionName?: PhysicalCollectionName): Promise<void> {
    await this.graphFinalizer.resolveAndUpsert(spillPath, collectionName);
  }

  /**
   * Recompute Tarjan SCC for both scopes and PageRank over the method graph once
   * pass-2 settles (`GraphBuildFinalizer#recomputeMetrics`).
   */
  private async recomputeGraphMetricsStreaming(collectionName?: PhysicalCollectionName): Promise<void> {
    try {
      await this.graphFinalizer.recomputeMetrics(collectionName);
    } finally {
      // The recompute is the last pass-2 stage, so this is the run's closing
      // wall-clock statement (bd tea-rags-mcp-6aytq) — from `finally`, because the
      // sink treats a metrics failure as best-effort.
      this.logPhaseTimings();
    }
  }

  /**
   * The run's wall-clock attribution (bd tea-rags-mcp-6aytq). The resolver block
   * is the run's one record of which Program strategy it took. Emitted once per
   * provider instance per run: after the metric recompute, or — for a language
   * partition that does not own collection completion — after its pass-2.
   */
  private logPhaseTimings(): void {
    if (!isDebug()) return;
    console.error(
      "[GitEnrich] PHASE: CODEGRAPH_PHASE_TIMINGS",
      JSON.stringify({ ...this.phaseTimings.toSummary(), resolvers: this.resolutionRunner.resolverDiagnostics() }),
    );
  }

  /**
   * Per-run counters for `EnrichmentMetrics.byProvider["codegraph.symbols"]`.
   * Read-and-clear: returning the snapshot resets internal state so the
   * next enrichment cycle starts at zero. CompletionRunner calls this
   * once per cycle.
   */
  getRunMetrics(): ProviderRunMetrics | undefined {
    // Both branches of the drain (empty run and real run) reset the eager
    // node-flush state with no key, so it is hoisted out of the branch here.
    const metrics = this.runState.drainMetrics();
    this.resetNodeFlushState();
    return metrics;
  }

  private collectionKey(collectionName?: string): string {
    return collectionName ?? "__direct__";
  }

  async buildFileSignals(root: string, options?: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> {
    // Per-file hashes for this run (bd tea-rags-mcp-6goqa), assigned before any
    // walk so both branches below stamp them.
    if (options?.contentHashes) this.runState.contentHashes = options.contentHashes;
    // Per-run inputs every resolver reads (project root, Gemfile, declared
    // dependencies, schema snapshots): provider construction precedes any project.
    this.runState.bindProjectRoot(root);
    this.runState.loadGemfile(root);
    this.runState.loadDeclaredDependencies(root);
    this.runState.loadSchemaSnapshots(root);
    // Caller-supplied paths (incremental reindex, and the production ingest path)
    // bypass `discoverSupportedFiles`, so they go through the same extractability
    // filter here — otherwise excluded test files would enter the graph.
    const targetRelPaths =
      options?.paths && options.paths.length > 0
        ? this.filterExtractablePaths(options.paths)
        : this.discoverSupportedFiles(root, options?.ignoreFilter);

    // Resolve the per-collection store ONCE for the whole pass.
    const { graphDb } = await this.getStore(options?.collectionName);

    // Walk each file through this provider's own sink; `finish` resolves pass-2.
    const sink = this.asExtractionSink(options?.collectionName);
    for (const relPath of targetRelPaths) {
      try {
        await sink.write(this.extractOneFile(root, relPath));
      } catch (err) {
        // One bad file must not take down the build; the sink buffers per file
        // and resolves on finish, so the graph stays consistent.
        if (process.env.DEBUG === "true") {
          process.stderr.write(`[codegraph] skip ${relPath}: ${(err as Error).message}\n`);
        }
      }
    }
    await sink.finish();

    // Emit an overlay for every relPath the caller listed (or every walked file),
    // so the coordinator sees a consistent overlay map shape.
    const overlayPaths = options?.paths && options.paths.length > 0 ? options.paths : targetRelPaths;
    const result = new Map<string, FileSignalOverlay>();
    await readCodegraphFileOverlays(graphDb, overlayPaths, result);
    return result;
  }

  /**
   * Per-batch streaming extraction into the lazily-created per-collection run
   * sink. Returns ∅ — file overlays need the finished graph (`finalizeSignals`).
   * Arrow property so `this` survives being passed as a coordinator callback.
   */
  streamFileBatch = async (
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> => {
    // bd tea-rags-mcp-svhqp (layer 3) — serialize batches per collection so
    // extract + spill + dedup run atomically and in order. Only catastrophic
    // spill IO rejects (per-file errors are swallowed), and then the run is
    // doomed anyway, so the rejection may propagate down the chain.
    const key = this.collectionKey(options?.collectionName);
    const prior = this.runBatchChains.get(key) ?? Promise.resolve();
    const result = prior.then(async () => this.streamFileBatchInner(root, batchPaths, options));
    this.runBatchChains.set(key, result);
    return result;
  };

  private async streamFileBatchInner(
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    const key = this.collectionKey(options?.collectionName);
    this.bindRunState(root, options);
    // yl9tv Task 5b — cross-pass: the chunk pass already fed this run's
    // extractions into the input spill (drained in finalizeSignals), and a
    // re-parse here would race the chunker pool on the process-global
    // tree-sitter. The flag rides FileSignalOptions so it survives the worker
    // boundary; `reindex_changes` never sets it.
    if (options?.crossPass) return new Map();
    const { sink, extracted } = this.ensureRunSink(key, options?.collectionName);
    const targets = this.filterExtractablePaths(batchPaths);
    for (const relPath of targets) {
      // bd tea-rags-mcp-svhqp (residual) — extract each file ONCE per run: a file
      // whose chunks span several batches would otherwise be re-spilled and its
      // calls tallied per spill, jittering resolveSuccessRate with batch composition.
      if (extracted.has(relPath)) continue;
      try {
        await sink.write(this.extractOneFile(root, relPath));
        extracted.add(relPath);
      } catch (err) {
        if (process.env.DEBUG === "true") {
          process.stderr.write(`[codegraph] skip ${relPath}: ${(err as Error).message}\n`);
        }
      }
    }
    // Fire-and-chain flush of THIS batch's buffered node defs, so `cg_symbols`
    // lands during embedding even for a sub-threshold incremental changeset. Not
    // awaited; `finalizeSignals` awaits the chain via `flushRemainder`.
    this.nodeFlush.flushPending(key, options?.collectionName);
    return new Map(); // signals deferred to finalizeSignals
  }

  /**
   * Bind the per-RUN state every pass-1 entry point needs before it writes, shared
   * by `streamFileBatch` and `absorbExtractedFiles` (two doors into one run): the
   * project root (TypeScript resolvers bind to it lazily; `finalizeSignals` gets
   * no usable root), the Gemfile (adx5p.1), declared dependencies, the schema
   * snapshots (bd tea-rags-mcp-8l5fo), and the run's content hashes — stamped onto
   * each row so the next drift check reads the CURRENT hash (6goqa/ymjxj). The
   * repair pass reaches this seam too.
   *
   * Called before the cross-pass early return on purpose: a cross-pass run still
   * finalizes off this state even though it parses nothing here.
   */
  private bindRunState(root: string, options?: FileSignalOptions): void {
    this.runState.bindProjectRoot(root);
    this.runState.loadGemfile(root);
    this.runState.loadDeclaredDependencies(root);
    this.runState.loadSchemaSnapshots(root);
    if (options?.contentHashes) this.runState.contentHashes = options.contentHashes;
  }

  /**
   * Pass-1 fan-out, extraction half — parse + walk only, stateless with respect
   * to the run (bd pass1-fanout). A `FileExtraction` is a pure function of its
   * file, so the executor dispatches this with NO routing key onto whichever
   * worker affinity left idle.
   *
   * It must NOT touch the graph store, upsert symbols, merge run-global state or
   * append to the spill — that is `absorbExtractedFiles`, on the pinned worker. It
   * binds only what the WALK reads (root, Gemfile, declared dependencies); schema
   * snapshots are a pass-2 input. Filtering happens here because the rule belongs
   * to this provider and the executor is provider-agnostic. A file that fails to
   * parse is SKIPPED, as in `streamFileBatchInner`.
   */
  extractFileBatch = async (root: string, paths: string[]): Promise<FileExtractionFanoutBatch> => {
    this.runState.bindProjectRoot(root);
    this.runState.loadGemfile(root);
    this.runState.loadDeclaredDependencies(root);
    const extractions: FileExtraction[] = [];
    const pass1ByLanguage: Record<string, FileExtractionPass1Telemetry> = {};
    for (const relPath of paths) {
      if (!this.fileExtractor.isExtractable(relPath)) continue;
      const startedAtMs = Date.now();
      try {
        const extraction = this.fileExtractor.parse(root, relPath);
        const language = extraction.language || "unknown";
        const total = (pass1ByLanguage[language] ??= { ms: 0, files: 0 });
        total.ms += Date.now() - startedAtMs;
        total.files += 1;
        extractions.push(extraction);
      } catch (err) {
        if (process.env.DEBUG === "true") {
          process.stderr.write(`[codegraph] skip ${relPath}: ${(err as Error).message}\n`);
        }
      }
    }
    return { extractions, pass1ByLanguage };
  };

  /**
   * Pass-1 fan-out, absorb half — everything `streamFileBatchInner` does around
   * its parse, for records parsed elsewhere (bd pass1-fanout). Runs ONLY on the
   * collection-pinned worker, keeping the single-writer invariant: symbol table,
   * node-def buffer, run-global merges and output spill are touched by one thread.
   *
   * Per-file writes are keyed by `relPath`, so their SET is order-independent; the
   * run-global aggregates are last-write-wins, so the executor still feeds batches
   * in admission order to keep a run byte-reproducible.
   *
   * Under language affinity (bd tea-rags-mcp-sgo8v) every partition absorbs every
   * record in that same order, and `absorbRoles` says which it OWNS: a `mirror`
   * merges the file's pass-1 state only (`CodegraphExtractionSink#mirror`), so this
   * partition resolves its own files against the project a single worker would
   * have assembled — the symbol table and the run-global maps are language-blind.
   */
  absorbExtractedFiles = async (
    root: string,
    extractions: FileExtraction[],
    options?: FileSignalOptions & {
      pass1ByLanguage?: Record<string, FileExtractionPass1Telemetry>;
      absorbRoles?: readonly FileExtractionAbsorbRole[];
    },
  ): Promise<void> => {
    const key = this.collectionKey(options?.collectionName);
    this.bindRunState(root, options);
    const { sink, extracted } = this.ensureRunSink(key, options?.collectionName);
    for (const [index, extraction] of extractions.entries()) {
      if (options?.absorbRoles?.[index] === "mirror") {
        if (this.runState.mirroredRelPaths.has(extraction.relPath)) continue;
        await sink.mirror(extraction);
        continue;
      }
      // Same guard as the serial path: a file whose chunks span several batches
      // is extracted once per run, or its calls are tallied per spill and
      // `resolveSuccessRate` jitters with batch composition (svhqp).
      if (extracted.has(extraction.relPath)) continue;
      await sink.write(extraction);
      extracted.add(extraction.relPath);
    }
    // Fold the extraction units' attribution into this run's phase timings — the
    // pinned worker is the one that reports the run, and the units that did the
    // parsing have no run of their own to report against.
    for (const [language, total] of Object.entries(options?.pass1ByLanguage ?? {})) {
      this.fileExtractor.recordPass1(language, total.ms, total.files);
    }
    this.nodeFlush.flushPending(key, options?.collectionName);
  };

  /**
   * Resolve (or lazily start) the run sink + extracted-path set for a collection
   * key. The run-start side effects fire once per run, whichever writer comes
   * first: reset the prior run's line map — at run START, not finalize, because
   * the deferred chunk pass reads it AFTER `finalizeSignals` — and reset the
   * resolve tally, or a prior run's counts leak into this run's `recordRunStats`
   * on the long-lived worker (bd tea-rags-mcp-svhqp).
   */
  private ensureRunSink(
    key: string,
    collectionName?: PhysicalCollectionName,
    skipDurableNodeWrite = false,
  ): { sink: CodegraphExtractionSink; extracted: Set<string> } {
    let sink = this.runSinks.get(key);
    if (!sink) {
      this.chunkSymbolByLine.delete(key);
      this.runState.resetTally();
      // A partition's `resolve` keeps its owned paths for the `readBack` that
      // follows (bd tea-rags-mcp-sgo8v); a run that never got that far must not
      // hand them to this one.
      this.runExtractedPaths.delete(key);
      sink = this.asExtractionSink(collectionName, skipDurableNodeWrite);
      this.runSinks.set(key, sink);
    }
    let extracted = this.runExtractedPaths.get(key);
    if (!extracted) {
      extracted = new Set();
      this.runExtractedPaths.set(key, extracted);
    }
    return { sink, extracted };
  }

  /**
   * yl9tv Task 5b cross-pass entry — MAIN thread. SYNC-appends each file's
   * `FileExtraction` (from the chunker worker's single parse) as one NDJSON line
   * to the deterministic per-collection INPUT spill, which the worker's
   * `finalizeSignals` drains: the disk file is the main→worker bridge. Deduped
   * per collection. The append is synchronous so the bytes are on disk before
   * finalize opens the file; IO errors are swallowed (debug-logged).
   */
  acceptExtraction = (extraction: FileExtraction, options?: { collectionName?: PhysicalCollectionName }): void => {
    // G3a (bd tea-rags-mcp-lx8sb): the cross-pass tee receives EVERY chunked file,
    // so it must apply the exclusion filter the batch path and buildFileSignals
    // apply, or excluded (test) files re-enter the graph.
    if (this.codegraphExclusionFilter.ignores(extraction.relPath)) return;
    const key = this.collectionKey(options?.collectionName);
    let written = this.xpassWritten.get(key);
    if (!written) {
      written = new Set();
      this.xpassWritten.set(key, written);
    }
    if (written.has(extraction.relPath)) return;
    written.add(extraction.relPath);
    const spillPath = this.inputSpillPath(options?.collectionName);
    try {
      mkdirSync(pathDirname(spillPath), { recursive: true });
      appendFileSync(spillPath, `${JSON.stringify(extraction)}\n`, "utf8");
    } catch (err) {
      if (process.env.DEBUG === "true") {
        process.stderr.write(`[codegraph] xpass spill append failed ${spillPath}: ${(err as Error).message}\n`);
      }
    }
    // Buffer this file's durable symbol defs (same helper as the sink) and flush
    // in bulk on the cadence, hoisting the node write into embedding; the sorted
    // drain then skips it (`skipDurableNodeWrite`). Order-independent:
    // `upsertSymbolsBulk` is last-wins per relPath. After the dedup guard, so once.
    this.nodeFlush.buffer(extraction.relPath, this.buildSymbolDefs(extraction), key, options?.collectionName);
  };

  /**
   * yl9tv Task 5b — truncate the per-collection input spill + reset the dedup set
   * at run start (MAIN thread, before any acceptExtraction). Called by
   * `coordinator.beginRun` ONLY on cross-pass (full-index) runs. Idempotent;
   * tolerates a missing dir/file (creates them).
   */
  beginExtractionRun = (collectionName?: PhysicalCollectionName): void => {
    const key = this.collectionKey(collectionName);
    // bd tea-rags-mcp-svhqp — a run-START seam that bypasses `ensureRunSink`, so it
    // must zero the tally and run-global maps itself: the cached provider would
    // otherwise leak a prior run's counts into this run's `recordRunStats`.
    this.runState.resetTally();
    this.clearRunState(key);
    this.xpassWritten.set(key, new Set());
    const spillPath = this.inputSpillPath(collectionName);
    try {
      mkdirSync(pathDirname(spillPath), { recursive: true });
      writeFileSync(spillPath, "", "utf8");
    } catch (err) {
      if (process.env.DEBUG === "true") {
        process.stderr.write(`[codegraph] xpass spill reset failed ${spillPath}: ${(err as Error).message}\n`);
      }
    }
  };

  /**
   * Cross-pass end-of-file-phase seam, awaited. The MAIN instance buffered node
   * defs in `acceptExtraction` and flushed only complete cadence batches; the
   * `N mod nodeFlushFiles` remainder is invisible to the worker instance's
   * finalize. Flushing it here, before the worker's pass-2, keeps nodes-before-edges
   * across the instance boundary, and rethrows a latched flush error before pass-2.
   * No-op off cross-pass (the buffer is empty).
   */
  endExtractionRun = async (collectionName?: PhysicalCollectionName): Promise<void> => {
    await this.nodeFlush.flushRemainder(this.collectionKey(collectionName), collectionName);
  };

  /**
   * Deterministic cross-pass INPUT-spill path for a collection. Pool mode uses
   * `GraphDbClientPool.inputSpillPathFor` (a `.xpass` dir the pool never purges,
   * so the worker's mid-run pool construction can't wipe it); direct mode (tests,
   * no pool) colocates under a hidden cwd subdir.
   */
  private inputSpillPath(collectionName?: string): string {
    return this.deps.pool
      ? this.deps.pool.inputSpillPathFor(collectionName ?? "__direct__")
      : join(process.cwd(), ".tea-rags-codegraph-spill", `xpass-${collectionName ?? "__direct__"}.ndjson`);
  }

  /**
   * yl9tv Task 5b — WORKER-side drain of the cross-pass input spill through this
   * run's sink, with the durable node write skipped (hoisted into
   * `acceptExtraction`'s eager flush). See `drainCrossPassInputSpill`.
   */
  private async drainInputSpill(key: string, collectionName?: PhysicalCollectionName): Promise<void> {
    await drainCrossPassInputSpill(
      this.inputSpillPath(collectionName),
      () => this.ensureRunSink(key, collectionName, true),
      async () => this.nodeFlush.flushRemainder(key, collectionName),
    );
  }

  /**
   * Finish the streamed run sink (resolve edges + recompute graph metrics),
   * read back FILE overlays for the extracted paths, then release per-run
   * state. Returns FILE overlays only — codegraph CHUNK signals come from the
   * coordinator's post-finalize `buildChunkSignals` pass (`defersChunkEnrichment`).
   * Does NOT clear `chunkSymbolByLine`: the deferred chunk pass still needs it
   * to resolve symbolIds; it is reset at the next run's first streamFileBatch.
   *
   * Under language affinity (bd tea-rags-mcp-sgo8v) the executor drives this in
   * two halves across every partition of the collection — see
   * `PartitionedFinalizeStage`. `resolve` does everything above except the
   * metric recompute and the read-back, and keeps the owned paths for `readBack`,
   * which the executor issues only once EVERY partition has resolved.
   */
  finalizeSignals = async (_root: string, options?: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> => {
    if (options?.finalizeStage === "readBack") return this.readBackPartition(options);
    const partitioned = options?.finalizeStage === "resolve";
    const key = this.collectionKey(options?.collectionName);
    const file = new Map<string, FileSignalOverlay>();
    // Seed the hash stamped onto every row pass-2 writes, BEFORE the drain and
    // `sink.finish()` (the writes). Every ingest path reaches this seam — a
    // cross-pass run's `streamFileBatch` no-ops on a DIFFERENT instance — so
    // without it the first index persists NULL and the next run repairs the whole
    // corpus (bd tea-rags-mcp-o317j).
    if (options?.contentHashes) this.runState.contentHashes = options.contentHashes;
    // The pass-1 slices the MAIN thread read (bd tea-rags-mcp-weno4), stashed
    // BEFORE `sink.finish()`, which runs the barrier — their only reader. Absent
    // for direct/test callers, which keep the graphDb read.
    if (options?.pass1Aggregates) this.runState.injectedPass1Aggregates = options.pass1Aggregates;
    let keepOwnedPathsForReadBack = false;
    try {
      // yl9tv Task 5b — cross-pass: pass-1 is deferred to here, so drain the
      // main-written input spill before `sink.finish()` resolves pass-2.
      // Non-cross-pass runs already populated the sink via streamFileBatch.
      if (options?.crossPass) await this.drainInputSpill(key, options?.collectionName);
      const sink = this.runSinks.get(key);
      // A partition's pass-2 ends while others may still be writing, so cycles
      // and PageRank wait for the completion owner's `readBack`.
      if (sink) await sink.finish(partitioned ? { recomputeMetrics: false } : undefined);
      const { graphDb } = await this.getStore(options?.collectionName);
      if (!partitioned) {
        const paths =
          options?.paths && options.paths.length > 0 ? options.paths : [...(this.runExtractedPaths.get(key) ?? [])];
        await readCodegraphFileOverlays(graphDb, paths, file);
      }
      // Persist the resolve breakdown (bd tea-rags-mcp-2jet-D) after
      // `sink.finish()`, so every resolved call is already counted. A partition
      // persists only its own languages, which the store scopes its writes by.
      await this.recordRunStats(graphDb, options?.runCoverage);
      // The completion owner reports the run's timings after the recompute; any
      // other partition's pass-2 would otherwise leave no record at all.
      if (partitioned && options?.ownsCollectionCompletion !== true) this.logPhaseTimings();
      keepOwnedPathsForReadBack = partitioned;
    } finally {
      this.runSinks.delete(key);
      if (!keepOwnedPathsForReadBack) this.runExtractedPaths.delete(key);
      this.runBatchChains.delete(key);
      this.xpassWritten.delete(key);
      this.clearRunState(key);
    }
    return file;
  };

  /**
   * The second half of a partitioned finalize (bd tea-rags-mcp-sgo8v), issued
   * once every partition of the collection has resolved: the graph is whole,
   * so the completion owner recomputes cycles and PageRank over it, and every
   * partition reads back the file overlays of the files it owns — a file's
   * fan-in may have been written by another partition's pass-2.
   */
  private async readBackPartition(options: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> {
    const key = this.collectionKey(options.collectionName);
    const file = new Map<string, FileSignalOverlay>();
    try {
      if (options.ownsCollectionCompletion === true) {
        await recomputeCodegraphMetricsBestEffort(async () =>
          this.recomputeGraphMetricsStreaming(options.collectionName),
        );
      }
      const { graphDb } = await this.getStore(options.collectionName);
      const paths =
        options.paths && options.paths.length > 0 ? options.paths : [...(this.runExtractedPaths.get(key) ?? [])];
      await readCodegraphFileOverlays(graphDb, paths, file);
    } finally {
      this.runExtractedPaths.delete(key);
    }
    return file;
  }

  /**
   * Persist the run's resolve tally (`persistRunResolveStats`). The tally is NOT
   * reset here — `getRunMetrics` owns read-and-clear.
   *
   * `runCoverage` absent means a direct caller outside the ingest pipeline
   * (tests, offline harnesses): it hands over the corpus it means to measure, so
   * the run is treated as covering it. Every pipeline finalize passes it
   * explicitly (`CompletionRunner#applyFileFinalize`).
   */
  private async recordRunStats(
    graphDb: GraphDbClient,
    runCoverage: EnrichmentRunCoverage = "wholeCorpus",
  ): Promise<void> {
    await persistRunResolveStats(this.runState, graphDb, runCoverage);
  }

  /**
   * Release per-run extraction state after finalize: reset the run-global
   * ancestor / extends / return-type / dispatch maps (mirrors `getRunMetrics`).
   * `chunkSymbolByLine` is intentionally NOT cleared here — the deferred chunk
   * pass reads it after finalize; it is reset at the next run's first
   * streamFileBatch (`key` retained for signature symmetry / future per-key use).
   */
  private clearRunState(key: string): void {
    this.runState.clearForNextRun();
    this.resetNodeFlushState(key);
  }

  /**
   * Task 2 — reset the eager node-flush state at a run-reset seam. With a `key`,
   * drops that collection's buffer + flushed-set entry; without one, clears both
   * maps (full release). Always resets the chain to a resolved promise so a
   * rejected chain from an aborted run never leaks into the next run's `await`.
   */
  private resetNodeFlushState(key?: string): void {
    this.nodeFlush.reset(key);
  }

  /**
   * Worker-pool release hook. The pinned worker calls it on the cached provider
   * when `WorkerPoolEnrichmentExecutor#releaseRun` releases the latest run begun
   * on the collection (bd tea-rags-mcp-39xca.3), then evicts the cache entry, so
   * dropping every per-run map and the line-range index is safe. A throw is
   * swallowed by the worker (bounded memory wins over perfect cleanup); the daemon
   * connection is multi-client, so a stale handle is harmless.
   */
  onRelease = async (): Promise<void> => {
    this.chunkSymbolByLine.clear();
    this.runSinks.clear();
    this.runExtractedPaths.clear();
    this.runBatchChains.clear();
    this.xpassWritten.clear();
    this.runState.clearAll();
    this.resetNodeFlushState();
  };

  /** Parse + walk one file from disk, recording its pass-1 time (`CodegraphFileExtractor#extract`). */
  private extractOneFile(root: string, relPath: string): FileExtraction {
    return this.fileExtractor.extract(root, relPath);
  }

  /** Supported-language files under `root`, both ignore layers applied (`CodegraphFileExtractor#discover`). */
  private discoverSupportedFiles(root: string, scannerIgnoreFilter?: Ignore): string[] {
    return this.fileExtractor.discover(root, scannerIgnoreFilter);
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const { graphDb } = await this.getStore(options?.collectionName);
    return this.chunkSignalPass.build(graphDb, chunkMap, this.collectionKey(options?.collectionName));
  }
}

/**
 * Flush cadence (files per batch) for the Task 2 eager node upsert during
 * embedding. Overridable via `CODEGRAPH_NODE_FLUSH_FILES`; a non-positive /
 * unparseable value falls back to the default. Read once at construction.
 */
function nodeFlushFilesFromEnv(): number {
  const raw = process.env.CODEGRAPH_NODE_FLUSH_FILES;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 256;
}
