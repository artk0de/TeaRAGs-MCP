/**
 * Codegraph symbols `EnrichmentProvider`: bridges walker output
 * (`FileExtraction`) and the graph DB (`GraphDbClient`).
 *
 *   - Pass-1 entry points (`streamFileBatch`, the fan-out's
 *     `absorbExtractedFiles`, cross-pass `acceptExtraction`) feed the run's
 *     extraction sink; its `finish` resolves pass-2 edges into the graph DB.
 *   - `finalizeSignals` / `buildFileSignals` read file overlays (fanIn / fanOut /
 *     instability / isHub / isLeaf / transitiveImpact) off the finished graph.
 *   - `buildChunkSignals`, the deferred chunk pass, settles each stored chunk's
 *     fanIn / fanOut / pageRank through `settleCodegraphChunkSignals`.
 */

import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { join, dirname as pathDirname, relative } from "node:path";
import { createInterface } from "node:readline";

import type { Ignore } from "ignore";
import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import GoLang from "tree-sitter-go";
import JavaLang from "tree-sitter-java";
import JsLang from "tree-sitter-javascript";
import PyLang from "tree-sitter-python";
import RbLang from "tree-sitter-ruby";
import RustLang from "tree-sitter-rust";
import TsLang from "tree-sitter-typescript";

import type { GraphDbClientPool } from "../../../../adapters/duckdb/pool.js";
import type {
  CodegraphPass1FileAggregates,
  ExtractionSink,
  FileExtraction,
  FileGraphMetrics,
  GlobalSymbolTable,
  GraphDbClient,
  SymbolChunkIdJoinEntry,
  SymbolDefinition,
  SymbolId,
  SymbolLineRange,
} from "../../../../contracts/types/codegraph.js";
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
import { fileIsInertForExtraction } from "../../../../infra/extraction-fast-path.js";
import { materializeTree } from "../../../../infra/materialize.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  buildCodegraphExclusionFilter,
  collectSchemaColumnSources,
  type CodegraphExclusionOptions,
} from "../exclusion.js";
import {
  CodegraphChunkSettlementTally,
  settleCodegraphChunkSignals,
  toChunkSignalOverlays,
  type CodegraphChunkRangeSource,
} from "./chunk-signal-settlement.js";
import { createCodegraphExtractionSink, type CodegraphSinkDeps } from "./extraction-sink.js";
import { GraphBuildFinalizer } from "./graph-finalizer.js";
import { SymbolNodeFlushQueue } from "./node-flush.js";
import {
  buildCodegraphFileSignals,
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "./payload-signals.js";
import { CodegraphPhaseTimings } from "./phase-timings.js";
import { CallEdgeResolutionRunner } from "./resolution-runner.js";
import { CodegraphRunState } from "./run-state.js";
import { lastSegment } from "./symbol-name.js";

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
 * Per-extension parser config. Codegraph walks any file whose extension has a
 * {@link CODEGRAPH_LANGUAGES} row; the walk and `nameOf` come from the injected
 * `LanguageFactoryDescriptor` (`factory.create(lang).walker`), keyed by language
 * name. Adding a language: a tree-sitter grammar dependency, a native
 * `domains/language/<lang>` provider, and a row here.
 */
export interface CodegraphLanguageConfig {
  language: string;
  loadParser: () => Parser.Language;
  /**
   * Joiner used to build the fully-qualified symbol id from the scope
   * stack + the local node name. TypeScript / Python use ".", Ruby
   * uses "::", Go uses ".", Rust uses "::". Wrong separator here
   * silently misroutes resolver lookups — Ruby `Acme::User` indexed as
   * `Acme.User` wouldn't match the receiver string the walker emits
   * for the call site.
   */
  scopeSeparator: string;
  /**
   * When true, duplicate composed symbolIds inside one file are disambiguated
   * with `~N` (first occurrence unchanged, second → `~2`, …) instead of deduped,
   * mirroring the chunker so cg_symbols and the Qdrant payload agree per AST node.
   * Enable where overloads carry distinct bodies (Java, bd tea-rags-mcp-a466);
   * leave false where same-name declarations are stub/impl or accessor pairs and
   * the first should win (Python singledispatch, bd d4ab; TS getter/setter).
   */
  disambiguateOverloads?: boolean;
}

export const CODEGRAPH_LANGUAGES: Record<string, CodegraphLanguageConfig> = {
  // `.ts` and `.tsx` load different grammars; the native TypeScript walker
  // handles both grammars' node types.
  ".ts": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).typescript,
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).tsx,
    scopeSeparator: ".",
  },
  ".py": {
    language: "python",
    loadParser: () => PyLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".rb": {
    language: "ruby",
    loadParser: () => RbLang as Parser.Language,
    scopeSeparator: "::",
  },
  // JavaScript variants — the single `tree-sitter-javascript` grammar serves all
  // four extensions.
  ".js": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".jsx": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".mjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".cjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".go": {
    language: "go",
    loadParser: () => GoLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".java": {
    language: "java",
    loadParser: () => JavaLang as Parser.Language,
    scopeSeparator: ".",
    // bd tea-rags-mcp-a466 — each Java overload needs its own symbolId so
    // `get_callers` / `get_callees` can pin the right body.
    disambiguateOverloads: true,
  },
  ".rs": {
    language: "rust",
    loadParser: () => RustLang as Parser.Language,
    scopeSeparator: "::",
  },
  // Bash — two extensions, one grammar (`.sh` and `.bash` share the single
  // BashLang).
  ".sh": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    scopeSeparator: ".",
  },
  ".bash": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    scopeSeparator: ".",
  },
};
const SUPPORTED_EXTS = new Set(Object.keys(CODEGRAPH_LANGUAGES));

/**
 * Files between pass-1 progress lines. Coarser than pass-2's 100 because the
 * line carries the larger phase-split payload; 500 keeps a 20k-file run at ~40
 * lines while bounding what a kill at the 5-minute budget can lose.
 */
const PASS1_PROGRESS_EVERY = 500;

/**
 * Files per `getFileMetricsBulk` request in the finalize read-back (bd
 * tea-rags-mcp-6aytq). The read-back is DAEMON-CPU-bound, not latency-bound: the
 * setwise op costs three statements per batch where per-file reads cost three per
 * file and queue the concurrent pass-2 flush behind them. A larger batch grows the
 * request frame and the recursive CTE's live intermediate; 2000 sits mid-plateau
 * of the measured cost curve.
 */
const OVERLAY_READ_BATCH = 2000;

/** Reading of a root the graph has no edge for, in either direction. */
const ZERO_FILE_METRICS: FileGraphMetrics = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

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
   * process, and two repos can share a relPath.
   */
  private readonly chunkSymbolByLine = new Map<string, Map<string, SymbolLineRange[]>>();
  /**
   * Active streaming extraction sink per collection key. Created lazily by the
   * first pass-1 writer, finished + consumed + deleted by `finalizeSignals`, so
   * streamed batches accumulate into one graph build.
   */
  private readonly runSinks = new Map<string, ExtractionSink>();
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
   * Codegraph-layer ignore filter (Layer 2 of `discoverSupportedFiles`), built once
   * from `deps.exclusion` plus each language's own non-app-code globs (bd
   * tea-rags-mcp-biwbq — e.g. Ruby's `db/migrate/**`). Never empty: the generated
   * + test patterns are unconditional.
   */
  private readonly codegraphExclusionFilter: Ignore;
  /**
   * Wall-clock attribution across pass-1 and pass-2 (bd tea-rags-mcp-6aytq). Owned
   * here, not by the finalizer, because pass-1 runs on this side and both halves
   * land in ONE summary. Lifetime is one (collection, run) pair in the pool, so no
   * reset seam is needed.
   */
  private readonly phaseTimings = new CodegraphPhaseTimings();

  /**
   * Next cumulative pass-1 file count that earns a progress line. Held as state
   * rather than derived with a modulo because a fan-out absorb folds a whole
   * unit in at once and can jump past an exact multiple (see `recordPass1`).
   */
  private nextPass1ProgressAt = PASS1_PROGRESS_EVERY;

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
   * Whether the walk can produce rows for this path at all — the predicate every
   * pass-1 entry point applies before parsing (bd tea-rags-mcp-65bkl). Beyond
   * `shouldEnrich`, it requires a {@link CODEGRAPH_LANGUAGES} row: a `tsconfig.json`
   * still gets its all-zero payload block but never a `cg_symbols_files` row, and
   * the repair diff has to know that.
   */
  private isExtractablePath(relPath: string): boolean {
    return SUPPORTED_EXTS.has(extensionOf(relPath)) && !this.codegraphExclusionFilter.ignores(relPath);
  }

  /**
   * Repair-diff scope: of the run's eligible files, the ones this graph can
   * actually persist a row for. Without it the diff asks for every JSON/Markdown
   * /YAML file the index carries, on every run, forever — they can never acquire
   * the row it looks for (bd tea-rags-mcp-65bkl).
   */
  filterExtractablePaths(paths: readonly string[]): string[] {
    return paths.filter((p) => this.isExtractablePath(p));
  }

  /**
   * What this graph currently believes about each file: `relPath -> content
   * hash`, `null` where the row predates the hash column (bd tea-rags-mcp-6goqa).
   * Read through the pool's READ handle (daemon-backed in production, where a
   * cross-process READ_ONLY attach would throw). A collection with no graph yet
   * yields an empty map — the fresh-`_vN` case, where every file needs extracting.
   */
  async readPersistedFileHashes(collectionName: string): Promise<Map<string, string | null>> {
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
  async readPersistedPass1Aggregates(collectionName: string): Promise<CodegraphPass1FileAggregates[]> {
    return (await this.getStore(collectionName)).graphDb.listAllPass1Aggregates();
  }

  /**
   * Resolve the (graphDb, symbolTable) pair for the active call: the
   * per-collection pool handle in pool mode, the constructor pair in direct mode.
   * Pool mode without `collectionName` throws — a broken call surface must fail at
   * the wire-up boundary, not write rows to the wrong DB.
   */
  private async getStore(collectionName?: string): Promise<{
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
  asExtractionSink(collectionName?: string, skipDurableNodeWrite = false): ExtractionSink {
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
        this.indexChunkSymbolsByLine(collectionName, extraction);
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
  private async streamingResolveAndUpsert(spillPath: string, collectionName?: string): Promise<void> {
    await this.graphFinalizer.resolveAndUpsert(spillPath, collectionName);
  }

  /**
   * Recompute Tarjan SCC for both scopes and PageRank over the method graph once
   * pass-2 settles (`GraphBuildFinalizer#recomputeMetrics`).
   */
  private async recomputeGraphMetricsStreaming(collectionName?: string): Promise<void> {
    try {
      await this.graphFinalizer.recomputeMetrics(collectionName);
    } finally {
      // The recompute is the last pass-2 stage, so this is the run's closing
      // wall-clock statement (bd tea-rags-mcp-6aytq) — from `finally`, because the
      // sink treats a metrics failure as best-effort. The resolver block is the
      // run's one record of which Program strategy it took.
      if (isDebug()) {
        console.error(
          "[GitEnrich] PHASE: CODEGRAPH_PHASE_TIMINGS",
          JSON.stringify({ ...this.phaseTimings.toSummary(), resolvers: this.resolutionRunner.resolverDiagnostics() }),
        );
      }
    }
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

  private indexChunkSymbolsByLine(collectionName: string | undefined, extraction: FileExtraction): void {
    // Every walked symbol's AST range (1-based, inclusive), nested ones included —
    // a stored chunk may belong to any of them (bd tea-rags-mcp-9i2ow). A chunk
    // without both walker lines is not indexed: half a range places nothing. A
    // re-walk replaces the file's ranges wholesale.
    const key = this.collectionKey(collectionName);
    let perColl = this.chunkSymbolByLine.get(key);
    if (!perColl) {
      perColl = new Map();
      this.chunkSymbolByLine.set(key, perColl);
    }
    const ranges: SymbolLineRange[] = [];
    for (const c of extraction.chunks) {
      if (c.startLine !== undefined && c.endLine !== undefined) {
        ranges.push({ symbolId: c.symbolId, startLine: c.startLine, endLine: c.endLine });
      }
    }
    perColl.set(extraction.relPath, ranges);
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
    await this.readFileOverlays(graphDb, overlayPaths, result);
    return result;
  }

  /**
   * Read file-level overlays for `overlayPaths` from the finished graph into
   * `out`, shared by `buildFileSignals` and `finalizeSignals`. `fanInP95` comes
   * from the FULL graph, not the subset, so `isHub` is not misclassified on an
   * incremental run. Bare inner keys under providerKey `codegraph.symbols.file`
   * (tea-rags-mcp-k6xu).
   */
  private async readFileOverlays(
    graphDb: GraphDbClient,
    overlayPaths: string[],
    out: Map<string, FileSignalOverlay>,
  ): Promise<void> {
    const fanInP95 = await graphDb.getFanInP95();
    // Batches go out in order and each is walked in the caller's order, so the
    // map this fills keeps `overlayPaths` order exactly. A root the graph knows
    // nothing about is absent from the bulk map and reads as all-zero — the
    // same value the per-file getters returned for it.
    for (let start = 0; start < overlayPaths.length; start += OVERLAY_READ_BATCH) {
      const batch = overlayPaths.slice(start, start + OVERLAY_READ_BATCH);
      const metrics = await graphDb.getFileMetricsBulk(batch);
      for (const relPath of batch) {
        // Shared with `CodegraphPayloadHealer` (bd tea-rags-mcp-a2ddb) — the
        // heal writes the same keys for files this pass never names, so the
        // arithmetic has exactly one home.
        out.set(relPath, buildCodegraphFileSignals(metrics.get(relPath) ?? ZERO_FILE_METRICS, fanInP95));
      }
    }
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
      if (!this.isExtractablePath(relPath)) continue;
      const startedAtMs = Date.now();
      try {
        const extraction = this.parseFileExtraction(root, relPath);
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
   */
  absorbExtractedFiles = async (
    root: string,
    extractions: FileExtraction[],
    options?: FileSignalOptions & { pass1ByLanguage?: Record<string, FileExtractionPass1Telemetry> },
  ): Promise<void> => {
    const key = this.collectionKey(options?.collectionName);
    this.bindRunState(root, options);
    const { sink, extracted } = this.ensureRunSink(key, options?.collectionName);
    for (const extraction of extractions) {
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
      this.recordPass1(language, total.ms, total.files);
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
    collectionName?: string,
    skipDurableNodeWrite = false,
  ): { sink: ExtractionSink; extracted: Set<string> } {
    let sink = this.runSinks.get(key);
    if (!sink) {
      this.chunkSymbolByLine.delete(key);
      this.runState.resetTally();
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
  acceptExtraction = (extraction: FileExtraction, options?: { collectionName?: string }): void => {
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
  beginExtractionRun = (collectionName?: string): void => {
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
  endExtractionRun = async (collectionName?: string): Promise<void> => {
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
   * yl9tv Task 5b — WORKER-side drain of the cross-pass input spill: each line
   * goes through a fresh run sink exactly as a re-parsed file would (symbol table,
   * run-global merges, output spill, line map), then the spill is removed. The
   * caller (`finalizeSignals`) finishes the sink. A missing spill is a no-op.
   */
  private async drainInputSpill(key: string, collectionName?: string): Promise<void> {
    const spillPath = this.inputSpillPath(collectionName);
    // Nothing fed this run: leave the sink uncreated so finalize reads back zero
    // overlays. Guarded up front because `createReadStream` surfaces ENOENT
    // asynchronously on the stream.
    if (!existsSync(spillPath)) return;
    // The durable node write was hoisted into `acceptExtraction`'s eager flush, so
    // this drain's sink skips it.
    const { sink, extracted } = this.ensureRunSink(key, collectionName, true);
    // Flush the buffered node remainder + await the chain + rethrow BEFORE the
    // drain, so `cg_symbols` is fully durable before pass-2.
    await this.nodeFlush.flushRemainder(key, collectionName);
    const reader = createInterface({
      input: createReadStream(spillPath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    // bd tea-rags-mcp-yl9tv — the spill is appended in non-deterministic
    // file-COMPLETION order, so buffer and SORT by relPath before resolving: every
    // last-write-wins run-global merge and the resolve tally must be reproducible.
    // One line per file (deduped at accept), so the buffer is bounded by file count.
    const extractions: FileExtraction[] = [];
    try {
      for await (const line of reader) {
        if (!line) continue;
        try {
          extractions.push(JSON.parse(line) as FileExtraction);
        } catch {
          continue; // skip a corrupt line rather than abort the whole drain
        }
      }
    } finally {
      reader.close();
      rmSync(spillPath, { force: true });
    }
    extractions.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    for (const extraction of extractions) {
      if (extracted.has(extraction.relPath)) continue;
      await sink.write(extraction);
      extracted.add(extraction.relPath);
    }
  }

  /**
   * Finish the streamed run sink (resolve edges + recompute graph metrics),
   * read back FILE overlays for the extracted paths, then release per-run
   * state. Returns FILE overlays only — codegraph CHUNK signals come from the
   * coordinator's post-finalize `buildChunkSignals` pass (`defersChunkEnrichment`).
   * Does NOT clear `chunkSymbolByLine`: the deferred chunk pass still needs it
   * to resolve symbolIds; it is reset at the next run's first streamFileBatch.
   */
  finalizeSignals = async (_root: string, options?: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> => {
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
    try {
      // yl9tv Task 5b — cross-pass: pass-1 is deferred to here, so drain the
      // main-written input spill before `sink.finish()` resolves pass-2.
      // Non-cross-pass runs already populated the sink via streamFileBatch.
      if (options?.crossPass) await this.drainInputSpill(key, options?.collectionName);
      const sink = this.runSinks.get(key);
      if (sink) await sink.finish();
      const { graphDb } = await this.getStore(options?.collectionName);
      const paths =
        options?.paths && options.paths.length > 0 ? options.paths : [...(this.runExtractedPaths.get(key) ?? [])];
      await this.readFileOverlays(graphDb, paths, file);
      // Persist the resolve breakdown (bd tea-rags-mcp-2jet-D) after
      // `sink.finish()`, so every resolved call is already counted.
      await this.recordRunStats(graphDb, options?.runCoverage);
    } finally {
      this.runSinks.delete(key);
      this.runExtractedPaths.delete(key);
      this.runBatchChains.delete(key);
      this.xpassWritten.delete(key);
      this.clearRunState(key);
    }
    return file;
  };

  /**
   * Persist the run's resolve tally (bd tea-rags-mcp-2jet-D, per-file since bd
   * tea-rags-mcp-xpmwg). The tally is NOT reset here — `getRunMetrics` owns
   * read-and-clear; this only mirrors the current snapshot to disk at finalize.
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
    const files = this.runState.toFileResolveStatsEntries();
    // Nothing resolved: no file's rows to replace, no language to cover.
    if (files.length === 0) return;
    const wholeCorpus = runCoverage === "wholeCorpus";

    // The legacy per-language measurement, written by whole-corpus runs ONLY: it
    // replaces a language's rows wholesale, so an incremental run would replace the
    // corpus breakdown with its batch (bd tea-rags-mcp-xpmwg).
    //
    // The "no call site attempted → keep the previous rows" guard protects only
    // this wholesale write: call-free files yield ALL-ZERO rows that would erase
    // the last real measurement (bd tea-rags-mcp-snbzk). It must NOT gate the
    // per-file write below — a file whose calls were all removed must replace its
    // rows with none, or the aggregate keeps counting calls that no longer exist.
    if (wholeCorpus) {
      const rows = this.runState.toResolveRunStatsRows();
      if (rows.some((r) => r.attempted > 0)) await graphDb.recordRunStats(rows);
    }

    // Every resolved file's rows, plus — for a whole-corpus run only — the
    // languages they cover, in one transaction. Coverage switches a language's
    // read from `cg_run_stats` to the per-file aggregate, which describes only what
    // incrementals touched until a whole-corpus run writes it.
    await graphDb.recordFileResolveStats({
      files,
      completeLanguages: wholeCorpus ? [...new Set(files.map((f) => f.language))] : [],
    });
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

  /**
   * Recursively enumerate supported-language files under `root`, applying two
   * ignore layers per entry (tea-rags-mcp-tf1o, hh4m):
   *
   *   Layer 1 — `scannerIgnoreFilter` (FileScanner's filter via
   *             `FileSignalOptions.ignoreFilter`): BUILTIN_IGNORE_PATTERNS + the
   *             user's `.gitignore` / `.contextignore` — the chunks do not exist
   *             in Qdrant either, so it must be honoured.
   *   Layer 2 — `this.codegraphExclusionFilter`: generated + test patterns,
   *             language globs and `CODEGRAPH_CUSTOM_EXCLUDE` — excluded from
   *             the graph while Qdrant still indexes them.
   *
   * Two layers, not a union: merging them either leaks codegraph-only patterns
   * into Qdrant or lets test files back into the graph. Directories are skipped
   * early on both layers (trailing-slash probe). Returns repo-relative POSIX paths.
   */
  private discoverSupportedFiles(root: string, scannerIgnoreFilter?: Ignore): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // Dotfiles are pruned at this layer (the scanner filter has no blanket
        // dotfile rule); `.claude-plugin/` is the one exception — shipped source.
        if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
        const full = join(dir, entry.name);
        const relPath = relative(root, full).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          // ignore.ignores() expects a path that semantically denotes
          // a directory (trailing slash) so `node_modules/` matches.
          const dirRel = `${relPath}/`;
          if (scannerIgnoreFilter?.ignores(dirRel)) continue;
          if (this.codegraphExclusionFilter.ignores(dirRel)) continue;
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SUPPORTED_EXTS.has(extensionOf(entry.name))) continue;
        if (scannerIgnoreFilter?.ignores(relPath)) continue;
        if (this.codegraphExclusionFilter.ignores(relPath)) continue;
        out.push(relPath);
      }
    };
    walk(root);
    return out;
  }

  /** Parse + walk one file from disk, recording its pass-1 time. */
  private extractOneFile(root: string, relPath: string): FileExtraction {
    const startedAtMs = Date.now();
    const extraction = this.parseFileExtraction(root, relPath);
    this.recordPass1(extraction.language, Date.now() - startedAtMs);
    return extraction;
  }

  /**
   * Fold extraction cost into the run's pass-1 total and, on the cadence, report
   * where the run stands. The line is the ONLY pass-1 telemetry a killed run
   * leaves behind, so it carries the cumulative per-language split and not just
   * a counter. JSON rather than an inspected object: the split nests past
   * `console.error`'s two-level default.
   *
   * `files` is 1 on the serial path (one call per parsed file) and the unit's
   * whole count when the fan-out folds an extraction unit's attribution in at
   * absorb time. The cadence is therefore a THRESHOLD CROSSING, not an exact
   * multiple: a single fan-out absorb can carry hundreds of files past the mark
   * at once, and `count % 500 === 0` would silently never fire again.
   */
  private recordPass1(language: string, durationMs: number, files = 1): void {
    this.phaseTimings.record("pass1", durationMs, { language: language || "unknown", count: files });
    const extracted = this.phaseTimings.count("pass1");
    if (extracted < this.nextPass1ProgressAt || !isDebug()) return;
    this.nextPass1ProgressAt = extracted - (extracted % PASS1_PROGRESS_EVERY) + PASS1_PROGRESS_EVERY;
    const elapsedMs = this.phaseTimings.elapsedMs();
    console.error(
      "[GitEnrich] PHASE: CODEGRAPH_PASS1_PROGRESS",
      JSON.stringify({
        extracted,
        elapsedMs,
        filesPerSec: elapsedMs > 0 ? Math.round((extracted / elapsedMs) * 1000 * 10) / 10 : 0,
        phases: this.phaseTimings.toSummary(),
      }),
    );
  }

  /** Parse + walk one file. Timing and progress belong to `extractOneFile`. */
  private parseFileExtraction(root: string, relPath: string): FileExtraction {
    const ext = extensionOf(relPath);
    const langConfig = CODEGRAPH_LANGUAGES[ext];
    if (!langConfig) {
      // discoverSupportedFiles already filters by SUPPORTED_EXTS; this
      // is a defensive guard for callers that pass paths directly.
      return { relPath, language: "", imports: [], chunks: [], fileScope: [] };
    }
    // The walker (walk + nameOf) comes from the injected factory, keyed by language
    // NAME; parser, scopeSeparator and disambiguateOverloads from CODEGRAPH_LANGUAGES.
    const { walker } = this.deps.languageFactory.create(langConfig.language);
    if (!walker) {
      // Defensive: a code language always has a walker (markdown — the only
      // walker-less provider — has no CODEGRAPH_LANGUAGES entry, so we never
      // reach here for it). Return an empty extraction rather than throw.
      return { relPath, language: langConfig.language, imports: [], chunks: [], fileScope: [] };
    }
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(langConfig.loadParser());
    // Materialize the native tree right after parse so collectSymbols and the walk
    // both see the deterministic plain-JS AstNode tree, as at the chunker boundary
    // (rdv7d).
    const nativeTree = parser.parse(code);
    // bd tea-rags-mcp-1v12o.2.4 — a file bearing none of the node types the walker
    // reads yields the empty extraction; ask the NATIVE tree before materializing
    // it, the most expensive thing pass-1 does on generated data tables.
    if (fileIsInertForExtraction(nativeTree.rootNode, walker.extractionBearingNodeTypes)) {
      return { relPath, language: langConfig.language, imports: [], chunks: [], fileScope: [] };
    }
    const materializedTree = { rootNode: materializeTree(nativeTree.rootNode, code) };
    const chunks = this.deps.collectSymbols(
      materializedTree,
      // Gem-gated declares (bd tea-rags-mcp-o5kwh): bind the run's Gemfile so the
      // Ruby nameOf gates class-body macro DECLARES to this project's gems.
      // undefined runGemfileContent -> FULL catalogue (other languages ignore it).
      (node) => walker.nameOf(node, this.runState.gemfileContent),
      langConfig.scopeSeparator,
      langConfig.disambiguateOverloads ?? false,
      this.deps.composer,
    );
    return walker.walk({
      tree: materializedTree,
      code,
      relPath,
      language: langConfig.language,
      chunks,
      // Gem-gated DSL grammar at extraction time (adx5p.1b): the run's Gemfile,
      // read once in loadGemfile. undefined → FULL catalogue.
      gemfileContent: this.runState.gemfileContent,
      // Vocabulary gating at extraction time (bd tea-rags-mcp-w205u.1): the run's
      // declared dependencies, walked once in loadDeclaredDependencies.
      // undefined → no manifest anywhere → FULL catalogue.
      declaredDependencies: this.runState.declaredDependencies,
    });
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const { graphDb } = await this.getStore(options?.collectionName);
    // One set-based fetch of every symbol's {fanIn, fanOut, pageRank}, then an
    // in-memory lookup per chunk; values equal the point getters (absent ⇒ {0,0,0}).
    const bulkStartMs = isDebug() ? Date.now() : 0;
    const chunkSignals = await graphDb.getChunkSignalsBulk();
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_CHUNK_SIGNALS_READ", {
        symbols: chunkSignals.size,
        durationMs: Date.now() - bulkStartMs,
      });
    }
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    // 6aytq — the symbol→chunk join is collected across the WHOLE pass and written
    // once at the end: per file it was one daemon round-trip of single-row UPDATEs.
    // Nothing in the loop reads it back, so deferring the write changes only its shape.
    const chunkIdJoins: SymbolChunkIdJoinEntry[] = [];
    const rangesByFile = this.chunkSymbolByLine.get(this.collectionKey(options?.collectionName));
    const settlementTally = new CodegraphChunkSettlementTally();
    for (const [relPath, entries] of chunkMap) {
      // The walker's ranges for this file, present only when this provider
      // walked it during this run.
      const ranges = rangesByFile?.get(relPath);
      // The one settlement every producer of these keys goes through (bd
      // tea-rags-mcp-39xca.2): the chunk-owner rule over an explicit range
      // source. A file the run claims but whose walk left no line index is
      // UNSETTLED and omitted from the overlays, so no caller stamps it — not an
      // empty map passed off as a result (bd tea-rags-mcp-fxio5).
      const settlement = settleCodegraphChunkSignals(this.chunkRangeSourceFor(relPath, ranges), entries, chunkSignals);
      settlementTally.record(relPath, settlement, entries.length);
      // Confidence-weighted fanIn/fanOut (bd tea-rags-mcp-s5ato) + PageRank from
      // the bulk map; bare inner keys (tea-rags-mcp-k6xu) under providerKey
      // `codegraph.symbols.chunk`.
      out.set(relPath, toChunkSignalOverlays(settlement, entries));
      // 0rskm — store-time symbol→covering-chunk join. The walker's ranges hold
      // EVERY extracted symbol, including methods of a collapsed class with no own
      // Qdrant chunk; project them to symbol→startLine and backfill
      // cg_symbols.chunk_id.
      if (ranges && ranges.length > 0) {
        const symbolStartLines = symbolStartLinesOf(ranges);
        // Named even when the join came back EMPTY (bd tea-rags-mcp-tslvq): the
        // write REPLACES per named file, and naming a file is the only way its
        // symbols' stale chunk_id is retired (`upsertSymbolsBulk` is a row diff).
        // A file absent from this pass, or never walked this run, is not named.
        chunkIdJoins.push({ relPath, chunkIds: computeSymbolChunkIds(symbolStartLines, entries) });
      }
    }
    if (chunkIdJoins.length > 0) {
      await graphDb.updateSymbolChunkIdsBulk(chunkIdJoins);
    }
    // Unconditional, once per pass: an unsettled chunk keeps no stamp and no
    // signals, and without this line the only trace is a degraded marker.
    const unsettled = settlementTally.describeUnsettled("chunk signal pass");
    if (unsettled !== undefined) process.stderr.write(`${unsettled}\n`);
    return out;
  }

  /**
   * The range source one file's stored chunks settle against in
   * `buildChunkSignals`. Every file that reaches that pass is one the run
   * claims — its chunks were stored by this run, or seeded for its forced repair
   * walk (bd tea-rags-mcp-fxio5) — so an extractable file with no walker ranges
   * is a walk that left nothing behind: `walk` with no ranges, UNSETTLED. It is
   * NOT a reason to read `cg_symbols`, whose rows may describe the file's
   * content before this run. Only a file the graph can never hold settles
   * without signal values.
   */
  private chunkRangeSourceFor(
    relPath: string,
    walkRanges: readonly SymbolLineRange[] | undefined,
  ): CodegraphChunkRangeSource {
    if (walkRanges !== undefined) return { kind: "walk", ranges: walkRanges };
    if (!SUPPORTED_EXTS.has(extensionOf(relPath))) return { kind: "none", reason: "non-extractable-language" };
    if (this.codegraphExclusionFilter.ignores(relPath)) return { kind: "none", reason: "excluded-from-graph" };
    return { kind: "walk", ranges: undefined };
  }
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
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

/**
 * The symbol→startLine input of {@link computeSymbolChunkIds}, projected from
 * the walker's per-file ranges exactly as the pre-9i2ow startLine-keyed line map
 * produced it: one symbol per start line, the LAST walked chunk at a line
 * winning, in first-seen line order. Kept that way on purpose — the join's
 * semantics are not part of the chunk-owner change (bd tea-rags-mcp-9i2ow).
 */
function symbolStartLinesOf(ranges: readonly SymbolLineRange[]): Map<SymbolId, number> {
  const symbolByStartLine = new Map<number, SymbolId>();
  for (const range of ranges) symbolByStartLine.set(range.startLine, range.symbolId);
  const out = new Map<SymbolId, number>();
  for (const [startLine, symbolId] of symbolByStartLine) out.set(symbolId, startLine);
  return out;
}

/**
 * Symbol→covering-chunk containment join (0rskm). For each symbol start line,
 * pick the tightest chunk whose range (or any of its non-contiguous
 * `lineRanges`) contains that line. "Tightest" = smallest covering span, so a
 * method's own chunk wins over the enclosing class chunk, and a `#partN` part
 * wins over a wide fallback. Symbols with no covering chunk are omitted (their
 * cg_symbols.chunk_id stays NULL → find_symbol fallback is a no-op for them).
 */
export function computeSymbolChunkIds(
  symbolStartLines: ReadonlyMap<SymbolId, number>,
  entries: readonly ChunkLookupEntry[],
): Map<SymbolId, string> {
  const out = new Map<SymbolId, string>();
  for (const [symbolId, line] of symbolStartLines) {
    let bestId: string | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const e of entries) {
      const span = coveringSpan(e, line);
      if (span !== undefined && span < bestSpan) {
        bestSpan = span;
        bestId = e.chunkId;
      }
    }
    if (bestId !== undefined) out.set(symbolId, bestId);
  }
  return out;
}

/**
 * Effective covering span of `entry` for `line`, or undefined if `line` is not
 * covered. When `lineRanges` is present, containment is checked against the
 * sub-range that holds the line and the span is that sub-range's width (Ruby
 * body groups: a tight group beats a wide whole-chunk span).
 */
function coveringSpan(entry: ChunkLookupEntry, line: number): number | undefined {
  if (entry.lineRanges && entry.lineRanges.length > 0) {
    let best: number | undefined;
    for (const r of entry.lineRanges) {
      if (line >= r.start && line <= r.end) {
        const w = r.end - r.start;
        if (best === undefined || w < best) best = w;
      }
    }
    return best;
  }
  if (line >= entry.startLine && line <= entry.endLine) return entry.endLine - entry.startLine;
  return undefined;
}
