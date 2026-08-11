/**
 * Codegraph symbols `EnrichmentProvider`.
 *
 * Bridges the chunker walker output (`FileExtraction`) and the graph DB
 * (`GraphDbClient`):
 *
 *   - `asExtractionSink()` returns the `ExtractionSink` the chunker
 *     writes to. Each `write` upserts file symbol definitions into the
 *     global symbol table and buffers the extraction; `finish` flushes
 *     resolved edges into the graph DB.
 *   - `buildFileSignals` reads `cg_symbols_edges_file` to produce
 *     fanIn / fanOut / instability / isHub / isLeaf for each file.
 *   - `buildChunkSignals` reads `cg_symbols_edges_method` to produce
 *     calledByCount / callSiteCount per chunk (head chunks of methods).
 *
 * `isHub` is left `false` in `buildFileSignals` — the proper
 * cohort-p95 decision is made by the `IsHubSignal` derived signal at
 * rerank time, which reads `bounds["file.fanIn"]` from collection
 * stats. The payload field stays present and stable.
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
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  SymbolDefinition,
  SymbolId,
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
  EnrichmentScope,
  FileSignalOptions,
  FileSignalOverlay,
  FilterDescriptor,
  ProviderRunMetrics,
  WorkerEnrichmentDescriptor,
} from "../../../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../../../contracts/types/reranker.js";
import { materializeTree } from "../../../../infra/materialize.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  buildCodegraphExclusionFilter,
  collectSchemaColumnSources,
  type CodegraphExclusionOptions,
} from "../exclusion.js";
import { createCodegraphExtractionSink, type CodegraphSinkDeps } from "./extraction-sink.js";
import { GraphBuildFinalizer } from "./graph-finalizer.js";
import { SymbolNodeFlushQueue } from "./node-flush.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";
import { CallEdgeResolutionRunner } from "./resolution-runner.js";
import { CodegraphRunState } from "./run-state.js";
import { lastSegment } from "./symbol-name.js";

/**
 * Layered ignore for `discoverSupportedFiles` (tea-rags-mcp-tf1o, hh4m):
 *
 *   Layer 1 — FileScanner `ignoreFilter` passed via `FileSignalOptions`.
 *             Carries BUILTIN_IGNORE_PATTERNS (node_modules, build, dist,
 *             .next, _nuxt, *.min.js, …) plus the user's `.gitignore` /
 *             `.contextignore` rules. Same source of truth as the main
 *             Qdrant ingest path — codegraph stays aligned with whatever
 *             files actually ended up in the index.
 *
 *   Layer 2 — `codegraphExclusionFilter` (this provider's instance field).
 *             Codegraph-specific patterns that DON'T apply to Qdrant
 *             ingest, principally test files. Test sources are valuable
 *             to index for semantic search ("show me tests for X") but
 *             pollute the dependency fan-graph (fanIn=0, fanOut=many
 *             dilutes hub/PageRank signals), so the exclusion is
 *             unconditional.
 *
 * Two layers, not a union: the layers carry different semantics. Layer 1
 * is "what the user excluded from indexing entirely" — must be honoured
 * because the corresponding chunks don't exist in Qdrant either. Layer 2
 * is "what codegraph specifically excludes from graph extraction while
 * Qdrant still indexes". Merging them would either over-exclude
 * (codegraph-only patterns leak into Qdrant) or under-exclude (test
 * files re-enter the graph).
 */

/**
 * Strip the `_vN` versioning suffix from a Qdrant collection name to
 * recover the public alias. The codegraph DB is alias-keyed by design
 * (per `IndexingOps.run`'s `removeCollection(alias)` contract) — but
 * the ingest pipeline writes Qdrant chunks to the versioned target
 * (`<alias>_v<N>`) because the alias doesn't exist yet during the
 * first index pass. Without this strip, `pool.acquire("code_xxx_v6")`
 * would open a per-version DuckDB file that the GraphFacade reader
 * (which always resolves the alias from the path) never finds.
 *
 * Convention: `setupCollection` produces names of the form
 * `${alias}_v${N}` where N is a positive integer. Anything that does
 * not match this exact shape is returned unchanged — test fixtures
 * pass arbitrary strings ("project-alpha") that must NOT be rewritten.
 *
 * Examples:
 *   stripVersionSuffix("code_035da920_v6") → "code_035da920"
 *   stripVersionSuffix("code_035da920")    → "code_035da920"
 *   stripVersionSuffix("project-alpha")    → "project-alpha"
 *   stripVersionSuffix("foo_v")            → "foo_v"  (no digit)
 *   stripVersionSuffix("foo_v1_v2")        → "foo_v1" (only one strip)
 */
export function stripVersionSuffix(collectionName: string): string {
  return collectionName.replace(/_v\d+$/, "");
}

/**
 * Per-language extraction dispatch table. Codegraph walks any file
 * whose extension appears here. The actual walk + `nameOf` come from the
 * injected `LanguageFactoryDescriptor` (`factory.create(lang).walker`); this map carries
 * only the parser-load + namespace config the engine still needs per extension.
 *
 * Adding a language: add a tree-sitter parser to deps, create a native
 * `domains/language/<lang>` provider with its walker, drop a row here for the
 * parser/separator config.
 *
 * All languages migrated to native `domains/language/<lang>` providers
 * (tea-rags-mcp-cen6); the dead `walker`/`nameOf` fields this config once
 * carried for the legacy adapter were removed by tea-rags-mcp-jh40. The map is
 * retained for `loadParser` / `scopeSeparator` / `disambiguateOverloads` and the
 * `SUPPORTED_EXTS` set.
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
   * When true, duplicate composed symbolIds inside one file are
   * disambiguated with `~N` (1-based; first occurrence unchanged,
   * second → `~2`, third → `~3`, …) instead of being deduped to a
   * single entry. Mirrors the chunker convention so cg_symbols + Qdrant
   * payload agree on a per-physical-AST-node identifier.
   *
   * Enable for languages where overloads carry semantically-distinct
   * bodies (Java method overloads — bd tea-rags-mcp-a466). Leave false
   * for languages where same-name top-level declarations are typically
   * stub/impl pairs (Python `@functools.singledispatch` — bd d4ab) or
   * accessor pairs (TS getter/setter on same property) where the first
   * occurrence should win.
   */
  disambiguateOverloads?: boolean;
}

export const CODEGRAPH_LANGUAGES: Record<string, CodegraphLanguageConfig> = {
  // All languages are native domains/language/<lang> providers; the engine reads
  // each walker (`walk`/`nameOf`) from `factory.create(lang).walker`. These
  // entries are retained only for `loadParser` (per-extension grammar choice) /
  // `scopeSeparator` / `disambiguateOverloads`. The per-extension grammar choice
  // for `.ts` vs `.tsx` lives here; the native provider's single walker handles
  // both grammars' node types.
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
    // bd tea-rags-mcp-a466 — Java methods can be overloaded; each
    // overload needs its own symbolId so `get_callers`/`get_callees`
    // can pin to the right body. Without disambiguation the codegraph
    // collapses every `StringUtils.upperCase` into one row and the
    // 19 `HashCodeBuilder#append` overloads merge into a single chunk
    // that no resolver call site can disambiguate.
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
 * Codegraph provider dependencies. Two routing modes are supported and
 * exactly one MUST be supplied at construction time:
 *
 *   - **Pool mode (production).** `pool` is the per-collection
 *     `GraphDbClientPool`. The provider resolves the active collection
 *     via `options.collectionName` on every ingest/query call and
 *     acquires the corresponding `<dataDir>/codegraph/<collection>.duckdb`.
 *     This is the path bootstrap wires; see `wireCodegraph` in
 *     `src/bootstrap/factory.ts`.
 *
 *   - **Direct mode (tests).** `graphDb` + `symbolTable` are a single
 *     pre-opened pair. The provider ignores `collectionName` and uses
 *     this pair for every call. Useful for unit tests that don't want
 *     to instantiate a pool just to exercise a single in-memory DB.
 *
 * Mixing the two is a programming error — when `pool` is set, the
 * direct fields are ignored.
 */
export interface CodegraphProviderDeps {
  /** Pool mode — per-collection DuckDB files routed via collectionName. */
  pool?: GraphDbClientPool;
  /** Direct mode — pre-opened graph client. Mutually exclusive with `pool`. */
  graphDb?: GraphDbClient;
  /** Direct mode — pre-built symbol table. Mutually exclusive with `pool`. */
  symbolTable?: GlobalSymbolTable;
  /**
   * Per-language capability source (walker + resolver), injected via DI from
   * the composition layer (`api/internal/composition.ts` / `bootstrap/factory.ts`).
   * The provider reads `factory.create(lang).walker` (`walk`/`nameOf`) for the
   * symbol-collection pass and `.resolver` (`resolve`/`resolveDispatch`) for
   * pass-2 edge resolution. Typed as the contracts `LanguageFactoryDescriptor` interface;
   * the concrete factory is never imported here (leaf-domain guard forbids
   * `trajectory/** -> domains/language/**`). Parser-load / scopeSeparator /
   * disambiguateOverloads are still sourced from `CODEGRAPH_LANGUAGES`.
   * bd tea-rags-mcp-cat4.
   */
  languageFactory: LanguageFactoryDescriptor;
  /**
   * Cross-language symbolId mapper passed to the injected `collectSymbols` to
   * compose fully-qualified ids per `.claude/rules/symbolid-convention.md`. Injected as
   * the contracts `SymbolIdComposer` interface (DI from bootstrap/api) — the
   * concrete `DefaultSymbolIdComposer` is never imported here (leaf-domain
   * guard forbids `trajectory/** -> domains/language/**`).
   */
  composer: SymbolIdComposer;
  /**
   * Symbol-range collector (yl9tv) — pure `domains/language/kernel` function
   * injected via DI for the same leaf-domain reason as `composer` (trajectory
   * may not import `domains/language`). The chunker worker imports the SAME
   * function via its dynamic `languageModulePath` so one parse can feed both
   * the chunks and the codegraph `FileExtraction`.
   */
  collectSymbols: CollectSymbolsFn;
  /** Derived signals + presets are wired by `createSymbolsTrajectory` in T9. */
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
 * The implementation moved to `run-state.ts` alongside the ancestor maps it
 * inverts; re-exporting here keeps every existing importer working without a
 * module cycle (`run-state.ts` must not import its own consumer).
 */
export { buildIncludedBy } from "./run-state.js";

export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[] = [];
  readonly presets: RerankPreset[];

  /**
   * codegraph CHUNK signals (fanIn/fanOut/pageRank) read the DuckDB graph,
   * which is only populated once the run sink's finish() resolves
   * (streamingResolveAndUpsert + recomputePageRank). Per-batch reads would
   * see an empty graph, so the coordinator skips per-batch chunk dispatch and
   * runs ONE buildChunkSignals pass after this provider's finalizeSignals.
   */
  readonly defersChunkEnrichment = true;

  /**
   * Per-collection (relPath -> startLine -> symbolId), populated by the
   * walker pass in `buildFileSignals` so `buildChunkSignals` can resolve
   * symbolId for each `ChunkLookupEntry` by line number.
   *
   * Keyed by collection name (`__direct__` sentinel in direct/test mode)
   * to keep state strictly isolated between collections — a single
   * `CodegraphEnrichmentProvider` instance is reused across the whole
   * process lifetime, so multiple `index_codebase` calls run sequentially
   * against the SAME provider. Sharing a flat `Map<relPath, ...>` would
   * let paths from project A bleed into project B's `buildChunkSignals`
   * lookups when a path string happens to repeat across roots.
   *
   * ChunkLookupEntry only carries `{chunkId, startLine, endLine}` —
   * symbolId is not part of the public contract.
   */
  private readonly chunkSymbolByLine = new Map<string, Map<string, Map<number, string>>>();
  /**
   * Active streaming extraction sink per collection key. Created lazily by the
   * first `streamFileBatch`, finished + consumed + deleted by `finalizeSignals`.
   * Held as run state so file batches accumulate into one graph build that the
   * single finalize pass resolves — mirrors what the legacy whole-repo
   * `buildFileSignals` sink did, but spread across streamed batches.
   */
  private readonly runSinks = new Map<string, ExtractionSink>();
  /**
   * Repo-relative paths extracted via `streamFileBatch` per collection key.
   * `finalizeSignals` reads back file overlays for exactly these paths when the
   * caller doesn't pass an explicit `options.paths` subset.
   */
  private readonly runExtractedPaths = new Map<string, Set<string>>();
  /**
   * Per-collection serialization tail for `streamFileBatch` (bd
   * tea-rags-mcp-svhqp layer 3). `file-phase.onBatch` pushes extract work
   * WITHOUT awaiting, so multiple `streamFileBatch` calls run concurrently on
   * this one cached provider and would otherwise race on the shared spill stream
   * + `extracted` set (a check-then-add dedup is TOCTOU under concurrency). Each
   * call chains off the prior so extract + spill + dedup run atomically and in a
   * deterministic order. Settled-tolerant: a rejected batch does not poison the
   * chain. Cleared per key in `finalizeSignals` / `onRelease`.
   */
  private readonly runBatchChains = new Map<string, Promise<unknown>>();
  /**
   * yl9tv Task 5b — MAIN-thread per-collection dedup set for cross-pass input
   * spill writes. `acceptExtraction` (main instance) appends each file's
   * `FileExtraction` to the deterministic input spill exactly once; a file whose
   * chunks span several processing units would otherwise be forwarded more than
   * once. Reset per collection in `beginExtractionRun` (run start). NOT the
   * worker-side parse gate — that is `options.crossPass`, sourced from the
   * pipeline and threaded through `FileSignalOptions` (survives the worker
   * structured-clone boundary; an in-process Set would not).
   */
  private readonly xpassWritten = new Map<string, Set<string>>();
  /**
   * Eager batched node upsert during embedding (cross-pass). Owns the durable
   * `cg_symbols` write chain shared by both entry points — `acceptExtraction`
   * (main-thread tee) and the extraction sink's `write` — so the write is hoisted
   * out of the post-embedding finalize tail. Reset alongside the run-global maps
   * at each run-reset seam.
   */
  private readonly nodeFlush = new SymbolNodeFlushQueue(
    async (collectionName) => this.getStore(collectionName),
    nodeFlushFilesFromEnv(),
  );
  /**
   * Pass-2 per-file call resolution (bd tea-rags-mcp-6vfrj / G2). Reads the
   * run-global maps this provider's pass-1 sink filled and emits one file's
   * `GraphEdges`; the resolve tally lands back in `runState.stats`. Assigned in
   * the constructor — a field initializer cannot read the `deps` parameter
   * property.
   */
  private readonly resolutionRunner: CallEdgeResolutionRunner;
  /**
   * Pass-2 completion (bd tea-rags-mcp-6vfrj / G2): the streaming spill →
   * resolve → bulk-upsert → checkpoint loop, plus the SCC / PageRank recompute.
   * Assigned in the constructor because it depends on `resolutionRunner`.
   */
  private readonly graphFinalizer: GraphBuildFinalizer;
  /**
   * Per-run aggregates + resolve tally (bd tea-rags-mcp-6vfrj / G2). One object
   * owns every run-global map the pass-1 sink merges into and pass-2 resolution
   * reads back, plus the run-metrics drain and the reset seams. The provider
   * keeps only the per-collection sink lifecycle maps below. Constructed with
   * the languages' persisted-schema column vocabularies (bd tea-rags-mcp-8l5fo)
   * — collected ONCE in the constructor, through the same `deps.languageFactory`
   * seam as the exclusion filter, because `factory.create` is expensive.
   */
  private readonly runState: CodegraphRunState;
  /**
   * Codegraph-layer ignore filter (Layer 2 in `discoverSupportedFiles`).
   * Built once at construction from `deps.exclusion` PLUS each registered
   * language's own non-app-code globs (`deps.languageFactory`, bd
   * tea-rags-mcp-biwbq — e.g. Ruby's `db/migrate/**`). Never empty: the
   * generated + test patterns are unconditional, so the layer always has
   * something to say.
   */
  private readonly codegraphExclusionFilter: Ignore;

  /**
   * Worker-pool descriptor — surfaced when the composition root wires this
   * provider for off-main-thread dispatch via `WorkerPoolEnrichmentExecutor`.
   * Inline-only callers (tests, the default inline executor) leave it
   * undefined; executor falls back to in-thread provider calls.
   */
  readonly workerDescriptor?: WorkerEnrichmentDescriptor;

  constructor(
    private readonly deps: CodegraphProviderDeps,
    workerDescriptor?: WorkerEnrichmentDescriptor,
  ) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
    this.workerDescriptor = workerDescriptor;
    this.runState = new CodegraphRunState(collectSchemaColumnSources(deps.languageFactory));
    this.resolutionRunner = new CallEdgeResolutionRunner(deps.languageFactory, this.runState);
    this.graphFinalizer = new GraphBuildFinalizer(
      async (collectionName) => this.getStore(collectionName),
      this.resolutionRunner,
      this.runState,
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
   * with the graph walk (bd tea-rags-mcp-5ikhf).
   *
   * The authority is `codegraphExclusionFilter`, the same instance
   * `discoverSupportedFiles`, `streamFileBatchInner`, `buildFileSignals` and
   * `acceptExtraction` consult. It carries the unconditional generated + test
   * patterns, each language's own non-app-code globs (Ruby's `db/migrate/**`)
   * and the user's `CODEGRAPH_CUSTOM_EXCLUDE`.
   *
   * The two must agree or the point is stranded. A path the walk drops can
   * never receive a `codegraph.symbols.<level>.enrichedAt` — no overlay is read
   * back for it, and codegraph is skipped by the backfill pass
   * (`defersChunkEnrichment`). Reporting it as "full" therefore leaves it owed
   * enrichment forever: `EnrichmentRecovery` re-selects it every run, dispatches
   * the provider, gets nothing back, and `markRecoveryResult` writes `degraded`
   * on every single run with nothing it can act on. Declining is what lets the
   * point be stamped `skippedAs` once and settled server-side.
   *
   * `isGenerated` stays as a separate check because the classifier sees things
   * a path glob cannot: `TEA_RAGS_GENERATED_PATTERNS` and the in-file
   * `@generated` content markers. `isTest` needs no check — the filter's test
   * patterns and the classifier's are the same constant.
   *
   * Docs are irrelevant to the graph and enrich fully (no chunk graph is
   * emitted for them anyway).
   */
  shouldEnrich(file: { relPath: string; classification: FileClassification }): EnrichmentScope {
    if (file.classification.isGenerated) return "none";
    if (this.codegraphExclusionFilter.ignores(file.relPath)) return "none";
    return "full";
  }

  /**
   * Resolve the (graphDb, symbolTable) pair for the active call. In pool
   * mode this acquires the per-collection handle; in direct mode it
   * returns the constructor-provided pair regardless of `collectionName`.
   *
   * Programming error (rather than typed): if pool mode is set but no
   * `collectionName` was threaded through, the call surface is broken.
   * Caller should always pass `options.collectionName` from the
   * coordinator. We surface this loudly so bugs surface at the wire-up
   * boundary instead of writing rows to the wrong DB.
   */
  /**
   * What this graph currently believes about each file: `relPath -> content
   * hash`, `null` where the row predates the hash column
   * (bd tea-rags-mcp-6goqa).
   *
   * Read through the pool's READ handle, which is daemon-backed in production —
   * the daemon owns the RW lock, so a cross-process READ_ONLY attach would
   * throw while it holds the file. A collection with no graph yet yields an
   * empty map rather than an error: that is the fresh-`_vN` case, where every
   * eligible file legitimately needs extracting.
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
      // Acquire the FULL versioned collection name (no strip): the write
      // path routes through `acquireWrite`, which hands back a daemon-backed
      // handle when a socket is configured, else the in-process RW handle.
      // The per-version DuckDB file matches what the RO reader opens via
      // `acquireRead`, both keyed on the same unstripped name.
      return this.deps.pool.acquireWrite(collectionName);
    }
    // Direct mode — both fields validated in the constructor.
    return {
      graphDb: this.deps.graphDb as GraphDbClient,
      symbolTable: this.deps.symbolTable as GlobalSymbolTable,
    };
  }

  /**
   * Drop codegraph state for files that no longer exist on disk. Called
   * by `EnrichmentCoordinator.notifyDeletions` before sync prunes the
   * corresponding Qdrant points — keeps `cg_symbols_edges_*` consistent
   * with the file set. Idempotent: removing a path the provider never
   * saw is a no-op (graphDb.removeFile + symbolTable.removeFile both
   * tolerate unknown paths).
   */
  async handleDeletedPaths(paths: string[], options?: DeletedPathOptions): Promise<void> {
    if (paths.length === 0) return;
    const { graphDb, symbolTable } = await this.getStore(options?.collectionName);
    const perColl = this.chunkSymbolByLine.get(this.collectionKey(options?.collectionName));
    for (const relPath of paths) {
      // `graphDb.removeFile` clears edges AND cg_symbols rows; the
      // separate `removeSymbolsForFile` is intentionally idempotent so
      // call sites that only want symbol-table cleanup (no edge
      // pruning) can use it independently. Calling both here is safe —
      // the second DELETE finds an empty set.
      await graphDb.removeFile(relPath);
      await graphDb.removeSymbolsForFile(relPath);
      symbolTable.removeFile(relPath);
      perColl?.delete(relPath);
    }
  }

  /**
   * Map a file's `FileExtraction` chunks to `SymbolDefinition[]` — the SINGLE
   * source of the 9-field def shape. Used by BOTH the streaming sink's `write`
   * (durable per-file / in-memory table build) AND `acceptExtraction`'s eager
   * batched buffer (Task 2), so the two node-write paths can never drift.
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
    }));
  }

  /**
   * Build an `ExtractionSink` bound to the active collection. The sink
   * captures the per-collection (graphDb, symbolTable) pair so all
   * downstream `write`/`finish` calls land in the right DuckDB file.
   *
   * `collectionName` is optional in direct mode (test fixtures), but
   * MUST be supplied in pool mode (production bootstrap). The provider
   * fails loud at the first store-resolution otherwise.
   *
   * `skipDurableNodeWrite` (Task 2) — when true, `write` still builds the
   * in-memory symbol table + line map + Half-B run-globals but SKIPS the durable
   * `graphDb.upsertSymbols` because it was already issued by the eager batched
   * flush. `drainInputSpill` passes true; the incremental path leaves it false.
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
   * Slice 2 streaming pass-2. Reads the NDJSON spill line-by-line,
   * resolves calls against the now-complete `symbolTable`, issues one
   * `upsertFile` per row, and CHECKPOINTs every `CHECKPOINT_EVERY`
   * files so the DuckDB WAL stays bounded.
   *
   * Memory footprint: O(1) in the spill size — one JSON line resident
   * at any time. The resolver's working set is the file's own chunks
   * and the global symbol table (already loaded in-memory).
   */
  private async streamingResolveAndUpsert(spillPath: string, collectionName?: string): Promise<void> {
    await this.graphFinalizer.resolveAndUpsert(spillPath, collectionName);
  }

  /**
   * Slice 2 / B2 + B3 — recompute Tarjan SCC for both scopes and
   * PageRank over the method graph after the streaming pass-2 settles.
   *
   * Streaming variant: builds the adjacency one row at a time via
   * `graphDb.streamAdjacency` rather than `listAdjacency` so the
   * adapter does not pre-allocate a `Map<string, string[]>` of all
   * edges (the prior code paid this cost twice — once on the DuckDB
   * side, once in the consumer). The algorithms themselves still need
   * full adjacency for the recursive DFS and rank vector iteration,
   * but skipping the intermediate copy is the pragmatic minimum that
   * still gives a meaningful win at slice-2 scale (25k method edges).
   * A spill-to-disk Tarjan is a future optimisation if real graphs
   * grow past JS-heap-friendly sizes.
   *
   * Errors are wrapped in `CodegraphMetricsError` so the prefetch
   * marker carries the failing stage in its message — debug log
   * alone is not enough when the failure happens silently mid-run.
   */
  private async recomputeGraphMetricsStreaming(collectionName?: string): Promise<void> {
    await this.graphFinalizer.recomputeMetrics(collectionName);
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
    // The walker emits each chunk with line ranges driven by the AST
    // node it came from — but the ingest chunker may split that range
    // across multiple Qdrant chunks for oversize methods. We index the
    // span [startLine..endLine] -> symbolId so lookup by any line
    // inside the chunk resolves to the right symbol.
    //
    // Keyed by collection so two projects with overlapping rel_paths
    // (e.g. both repos hold `src/index.ts`) never share line maps.
    const key = this.collectionKey(collectionName);
    let perColl = this.chunkSymbolByLine.get(key);
    if (!perColl) {
      perColl = new Map();
      this.chunkSymbolByLine.set(key, perColl);
    }
    let lineMap = perColl.get(extraction.relPath);
    if (!lineMap) {
      lineMap = new Map();
      perColl.set(extraction.relPath, lineMap);
    } else {
      lineMap.clear();
    }
    for (const c of extraction.chunks) {
      if (c.startLine !== undefined) lineMap.set(c.startLine, c.symbolId);
    }
  }

  private resolveChunkSymbolId(
    collectionName: string | undefined,
    relPath: string,
    startLine: number,
    endLine: number,
  ): string | undefined {
    const perColl = this.chunkSymbolByLine.get(this.collectionKey(collectionName));
    if (!perColl) return undefined;
    const lineMap = perColl.get(relPath);
    if (!lineMap) return undefined;
    // Exact match by startLine wins. If the chunker split an oversized
    // method, intermediate chunks won't have a direct startLine match
    // — fall back to the largest indexed startLine that's <= this
    // chunk's startLine AND inside its end (best-effort containment).
    const exact = lineMap.get(startLine);
    if (exact) return exact;
    let best: { start: number; sym: string } | undefined;
    for (const [line, sym] of lineMap) {
      if (line <= startLine && line <= endLine) {
        if (!best || line > best.start) best = { start: line, sym };
      }
    }
    return best?.sym;
  }

  async buildFileSignals(root: string, options?: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> {
    // Per-file hashes for this run (bd tea-rags-mcp-6goqa) — the finalizer
    // stamps each written row with one so the next run's repair check can tell
    // a current row from a stale one. Assigned before any walk so both the
    // caller-supplied-paths branch and the standalone walk see it.
    if (options?.contentHashes) this.runState.contentHashes = options.contentHashes;
    // Read the run's Gemfile for gem-gated DSL grammar (adx5p.1) before pass-2
    // resolve reads it off each CallContext. One read per run (guarded).
    this.runState.loadGemfile(root);
    // Read the run's persisted-schema snapshot(s) for the barrier schema-column
    // pre-pass (bd tea-rags-mcp-8l5fo). One read per run (guarded), same shape.
    this.runState.loadSchemaSnapshots(root);
    // Discover the file set to walk. Caller-supplied paths win
    // (incremental reindex); otherwise scan the repo for any
    // supported language extension. `ignoreFilter` is threaded from the
    // EnrichmentCoordinator's ProviderContext (FileScanner's filter +
    // BUILTIN_IGNORE_PATTERNS); when absent (direct/test mode) only the
    // codegraph-layer filter applies.
    //
    // Codegraph-layer exclusion (CODEGRAPH_TEST_PATTERNS +
    // CODEGRAPH_CUSTOM_EXCLUDE) MUST be applied in BOTH branches: the
    // production ingest path threads its full file list as
    // `options.paths` (so `discoverSupportedFiles` is bypassed), and
    // without filtering here test files would land in the dependency
    // graph despite the exclusion. The standalone-walk branch
    // delegates to `discoverSupportedFiles`, which applies the filter
    // internally — the explicit `.filter` here covers the
    // caller-supplied branch with the same `codegraphExclusionFilter`
    // instance to keep semantics identical.
    const targetRelPaths =
      options?.paths && options.paths.length > 0
        ? options.paths.filter((p) => SUPPORTED_EXTS.has(extensionOf(p)) && !this.codegraphExclusionFilter.ignores(p))
        : this.discoverSupportedFiles(root, options?.ignoreFilter);

    // Resolve the per-collection store ONCE for the whole pass — the
    // overlay loop below uses the same handle. Pool mode threads
    // collectionName from the coordinator; direct mode (tests) ignores
    // it and returns the constructor-provided pair.
    const { graphDb } = await this.getStore(options?.collectionName);

    // Populate the graph DB by walking each file's AST and feeding the
    // resulting FileExtraction through this provider's own sink. This
    // pass owns the codegraph ingest side — chunker pool integration
    // is deferred to a future slice once worker IPC supports passing
    // FileExtraction back across the boundary.
    const sink = this.asExtractionSink(options?.collectionName);
    for (const relPath of targetRelPaths) {
      try {
        await sink.write(this.extractOneFile(root, relPath));
      } catch (err) {
        // One bad file shouldn't take down the whole codegraph build —
        // log the path on debug and keep going. The graph stays consistent
        // because asExtractionSink buffers per file and resolves on finish.
        if (process.env.DEBUG === "true") {
          process.stderr.write(`[codegraph] skip ${relPath}: ${(err as Error).message}\n`);
        }
      }
    }
    await sink.finish();

    // Second pass: emit metric overlays per file (delegated to
    // readFileOverlays, shared with finalizeSignals). We emit a row for every
    // relPath the caller listed (or every file we walked), so the enrichment
    // coordinator sees a consistent overlay map shape.
    const overlayPaths = options?.paths && options.paths.length > 0 ? options.paths : targetRelPaths;
    const result = new Map<string, FileSignalOverlay>();
    await this.readFileOverlays(graphDb, overlayPaths, result);
    return result;
  }

  /**
   * Read file-level codegraph overlays for `overlayPaths` from the finished
   * graph into `out`. Shared by `buildFileSignals` (whole-repo / backfill) and
   * `finalizeSignals` (streamed run). `fanInP95` is read ONCE from the FULL
   * graph in DuckDB (not the overlay subset) so `isHub` is not misclassified on
   * an incremental subset. Bare inner keys (tea-rags-mcp-k6xu) — written under
   * providerKey `codegraph.symbols.file`, so the addressable path is
   * `codegraph.symbols.file.fanIn`.
   */
  private async readFileOverlays(
    graphDb: GraphDbClient,
    overlayPaths: string[],
    out: Map<string, FileSignalOverlay>,
  ): Promise<void> {
    const fanInP95 = await graphDb.getFanInP95();
    for (const relPath of overlayPaths) {
      const fanIn = await graphDb.getFanIn(relPath);
      const fanOut = await graphDb.getFanOut(relPath);
      const denom = fanIn + fanOut;
      const transitiveImpact = await graphDb.getTransitiveImpact(relPath);
      out.set(relPath, {
        fanIn,
        fanOut,
        instability: denom === 0 ? 0 : fanOut / denom,
        connectionCount: denom,
        isHub: fanIn > fanInP95,
        isLeaf: fanOut === 0 && fanIn > 0,
        transitiveImpact,
      });
    }
  }

  /**
   * Per-batch streaming extraction: extract the batch's supported files into
   * the lazily-created per-collection run sink, return ∅ (file overlays are
   * deferred to `finalizeSignals` — they need the finished whole graph). Arrow
   * property so `this` survives being passed as a coordinator callback.
   */
  streamFileBatch = async (
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> => {
    // bd tea-rags-mcp-svhqp (layer 3) — serialize concurrent batches per
    // collection. file-phase fires streamFileBatch without awaiting, so chain
    // each call off the prior: extract + spill + dedup then run atomically and
    // in deterministic order on the shared spill stream + extracted set, instead
    // of racing (a check-then-add dedup is TOCTOU under concurrency). A batch
    // only rejects on catastrophic spill IO (per-file extraction errors are
    // swallowed inside the inner loop) — at which point the whole run is already
    // doomed, so letting that reject propagate down the chain is acceptable and
    // keeps the wrapper branch-free.
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
    // Gem-gated DSL grammar (adx5p.1): read the run's Gemfile before the crossPass
    // early-return so finalizeSignals resolves pass-2 off this state (one/run).
    this.runState.loadGemfile(root);
    // Read the run's persisted-schema snapshot(s) for the barrier schema-column
    // pre-pass (bd tea-rags-mcp-8l5fo). One read per run (guarded), same shape.
    this.runState.loadSchemaSnapshots(root);
    // yl9tv Task 5b — cross-pass: the full-index chunk pass has fed this run's
    // extractions into the input spill (drained in finalizeSignals), so the
    // worker/main re-parse here is redundant AND would race the chunker pool's
    // parse on the process-global tree-sitter. Skip it entirely. The flag comes
    // from the pipeline via FileSignalOptions (NOT provider state) so it survives
    // the worker-pool structured-clone boundary. `reindex_changes` never sets it
    // → the incremental path keeps its extractOneFile re-parse.
    if (options?.crossPass) return new Map();
    const { sink, extracted } = this.ensureRunSink(key, options?.collectionName);
    const targets = batchPaths.filter(
      (p) => SUPPORTED_EXTS.has(extensionOf(p)) && !this.codegraphExclusionFilter.ignores(p),
    );
    for (const relPath of targets) {
      // bd tea-rags-mcp-svhqp (residual) — extract each file ONCE per run.
      // `file-phase` dedups relPaths within a batch but not across batches, so a
      // file whose chunks span several streamed batches reaches here more than
      // once. Without this guard it is re-extracted + re-spilled and its calls
      // are tallied per spill, making callsAttempted (and resolveSuccessRate)
      // jitter run-to-run with batch composition. `extracted` is the run's
      // already-spilled set (also reused by finalize for overlay read-back).
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
    // Fire-and-chain flush of THIS batch's buffered node defs so each streamed
    // batch's `cg_symbols` land durably DURING embedding overlap. The cadence
    // threshold alone would defer a sub-threshold changeset (the common
    // incremental case) to the finalize remainder, losing the overlap the former
    // per-file `upsertSymbols` had. Not awaited — overlaps the next embedding
    // batch; `finalizeSignals` awaits the chain via `flushRemainder`.
    this.nodeFlush.flushPending(key, options?.collectionName);
    return new Map(); // signals deferred to finalizeSignals
  }

  /**
   * Resolve (or lazily start) the run sink + extracted-path set for a collection
   * key. The run-start side effects fire exactly once per run regardless of
   * whether the first writer is `streamFileBatchInner` (direct / non-cross-pass)
   * or `acceptExtraction` (yl9tv cross-pass): reset the prior run's
   * per-collection `chunkSymbolByLine` line map (leak fix — done at run START,
   * NOT finalize, because the deferred chunk pass consumes it AFTER
   * finalizeSignals) and reset the per-run resolve tally `runStats`
   * (bd tea-rags-mcp-svhqp — otherwise a prior run's tally leaks into the next
   * run's `recordRunStats` on the long-lived daemon and jitters
   * `resolveSuccessRate`), then open the spill sink.
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
   * yl9tv Task 5b cross-pass entry — MAIN thread. The full-index chunk pass
   * forwards each file's codegraph `FileExtraction` (built from the chunker
   * worker's SINGLE parse) here; we SYNC-APPEND it as one NDJSON line to the
   * deterministic per-collection INPUT spill. No run sink, no symbol upsert, no
   * finalize on the main thread — the off-thread worker's `finalizeSignals`
   * (crossPass) drains this exact file later (both pools share `rootDir` →
   * identical path), so the disk file IS the main→worker bridge. `relPath` is
   * already root-relative (the file-processor sets it before forwarding). Deduped
   * per collection so a file whose chunks span several processing units spills
   * once. Append is SYNCHRONOUS (not a stream) so the bytes are flushed to disk
   * before the worker's finalize opens the file — finalize is dispatched only
   * after the whole file phase drains. Best-effort: IO errors are swallowed
   * (debug-logged) so a spill hiccup never aborts indexing.
   */
  acceptExtraction = (extraction: FileExtraction, options?: { collectionName?: string }): void => {
    // G3a (bd tea-rags-mcp-lx8sb): the cross-pass tee receives EVERY chunked
    // file from the file-processor — unlike the batch path (streamFileBatchInner)
    // and buildFileSignals, which filter. Without this guard a test-classified
    // file (spec/support/gem_extensions/capybara.rb reopening `module Capybara`)
    // enters the graph despite the test exclusion, defeats the DEFECT-1
    // external-root gate, and re-records the dnd_helpers aggregates on every
    // --force reindex.
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
    // Task 2 — also buffer this file's durable symbol defs (built via the SAME
    // helper as `asExtractionSink`) and flush in bulk once the per-collection
    // buffer reaches the cadence. This HOISTS the former drain-time per-file
    // `graphDb.upsertSymbols` forward into embedding; the sorted drain later
    // skips it (`skipDurableNodeWrite`). Order-independent: `upsertSymbolsBulk`
    // is last-wins per relPath, so accept-order flushing == sorted-drain rows.
    // Runs after the dedup guard above, so a file is buffered exactly once.
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
    // bd tea-rags-mcp-svhqp — this is a run-START seam that bypasses
    // `ensureRunSink` (the cross-pass main thread feeds the input spill, the
    // sink is created later by the worker's `drainInputSpill`). On the
    // long-lived daemon the provider instance is cached and reused, so unless
    // EVERY run-start path zeroes the per-run resolve tally + run-global maps,
    // a prior run whose `getRunMetrics` (read-and-clear) never fired leaks its
    // counts into this run's `recordRunStats` → `resolveSuccessRate` jitters
    // run-to-run. Make this the authoritative zero-seam for the cross-pass
    // entry, mirroring `ensureRunSink` for the streaming entry.
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
   * Cross-pass end-of-file-phase seam — mirror of `beginExtractionRun`, awaited.
   * The cross-pass file phase feeds `acceptExtraction` on THIS (main-thread)
   * instance, which buffers each file's durable symbol defs and flushes only
   * COMPLETE `nodeFlushFiles` batches during embedding overlap. The trailing
   * `N mod nodeFlushFiles` files sit unflushed in `nodeDefBuffer`. finalize runs
   * on a SEPARATE worker instance whose own buffer is empty, so its
   * `flushNodeRemainder` never reaches this remainder. Flush it here — before the
   * coordinator dispatches the worker's `finalizeSignals` (pass-2 edge resolve) —
   * so `cg_symbols` is fully durable before any edge references it
   * (nodes-before-edges across the main↔worker instance boundary). Also awaits the
   * whole eager-flush chain and rethrows a latched flush error, aborting the run
   * before pass-2. No-op for non-cross-pass runs (buffer empty — the incremental
   * finalize on this same instance already owns the flush via `sink.finish`).
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
   * yl9tv Task 5b — WORKER-side drain of the cross-pass input spill. Streams the
   * main-written NDJSON line-by-line (O(1) memory, mirrors
   * `streamingResolveAndUpsert`) through a fresh run sink — each `write` performs
   * pass-1 (symbol upsert + run-global merges + output-spill append + line map)
   * exactly as `streamFileBatchInner` would for a re-parsed file. Removes the
   * input spill after draining. The sink it creates is finished by the caller
   * (`finalizeSignals`) for pass-2 resolve. A missing input spill (codegraph on
   * but no walkable files fed) is a no-op.
   */
  private async drainInputSpill(key: string, collectionName?: string): Promise<void> {
    const spillPath = this.inputSpillPath(collectionName);
    // No input spill on disk — nothing was fed this run. Leave the run sink
    // uncreated so finalize reads back zero overlays (graceful empty run).
    // (createReadStream surfaces ENOENT asynchronously on the stream, so guard
    // up front rather than catching it inside the `for await`.)
    if (!existsSync(spillPath)) return;
    // Task 2 — the durable node write was hoisted into `acceptExtraction`'s eager
    // batched flush, so this drain's sink SKIPS the per-file `graphDb.upsertSymbols`
    // (it still builds the in-memory symbol table + line map + Half-B run-globals).
    const { sink, extracted } = this.ensureRunSink(key, collectionName, true);
    // Flush the buffered node remainder + await the chain + rethrow BEFORE the
    // sorted drain, so `cg_symbols` is fully durable before pass-2 (see
    // `flushNodeRemainder`).
    await this.nodeFlush.flushRemainder(key, collectionName);
    const reader = createInterface({
      input: createReadStream(spillPath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    // bd tea-rags-mcp-yl9tv — the input spill is appended in file-COMPLETION
    // order under `fileConcurrency`, which is non-deterministic run-to-run.
    // Buffer every line, then SORT by relPath before resolving so the drain
    // order — and therefore every order-dependent run-global merge
    // (runAncestors / runReturnTypes / runDispatchTables, all last-write-wins)
    // plus the resolve tally — is reproducible regardless of the order the
    // chunk pass happened to spill files in. The spill is one line per file
    // (deduped at acceptExtraction), so the buffer is bounded by file count.
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
    // Gem-gated DSL grammar (adx5p.1): the run's Gemfile was read in the preceding
    // streamFileBatch pass (loadGemfile, guarded), so the pass-2 resolve below
    // (sink.finish) sees `runGemfileContent` on each CallContext already.
    const file = new Map<string, FileSignalOverlay>();
    try {
      // yl9tv Task 5b — cross-pass: streamFileBatch no-opped (no parse), so
      // pass-1 is deferred to here. Drain the main-written input spill through a
      // fresh run sink (symbol upsert + output-spill append + line map), then the
      // sink.finish() below resolves pass-2. Non-crossPass runs (reindex_changes,
      // direct mode) already populated the sink via streamFileBatch's
      // extractOneFile path, so this is skipped and the existing sink is used.
      if (options?.crossPass) await this.drainInputSpill(key, options?.collectionName);
      const sink = this.runSinks.get(key);
      if (sink) await sink.finish();
      const { graphDb } = await this.getStore(options?.collectionName);
      const paths =
        options?.paths && options.paths.length > 0 ? options.paths : [...(this.runExtractedPaths.get(key) ?? [])];
      await this.readFileOverlays(graphDb, paths, file);
      // bd tea-rags-mcp-2jet-D — flush the per-receiver-kind resolve breakdown
      // (j431) to `cg_run_stats` so the daemon-readable proxy surfaces each
      // cai0 slice's per-bucket delta. Overwrite semantics live in the client;
      // the provider only maps the in-memory tally to rows. Runs after
      // sink.finish() so every resolved call is already counted.
      await this.recordRunStats(graphDb);
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
   * Map the in-memory per-receiver-kind tally (`runStats.byReceiverKind`, j431)
   * to `ResolveRunStatsRow[]` and persist it via `graphDb.recordRunStats`
   * (bd tea-rags-mcp-2jet-D). One row per `RECEIVER_KIND` the provider observed;
   * the client overwrites the whole table so stale prior-run buckets never leak.
   * The tally is NOT reset here — `getRunMetrics` owns read-and-clear; this only
   * mirrors the current snapshot to disk at finalize.
   */
  private async recordRunStats(graphDb: GraphDbClient): Promise<void> {
    // bd tea-rags-mcp-cnqrg — one row per (observed language, receiver kind).
    // The client overwrites the whole table so stale prior-run cells never leak;
    // a language absent from this run simply has no rows.
    const rows = this.runState.toResolveRunStatsRows();
    // A run that observed NO call site has no breakdown to publish, and
    // `recordRunStats` is DELETE+INSERT — persisting such a run does not report
    // "nothing resolved", it ERASES the last real measurement: prime and
    // get_index_status then drop the `## Codegraph resolve` section entirely and
    // the number behind an epic's claim is gone. Keep the previous run's rows —
    // slightly stale beats absent, and the next run that observes anything
    // overwrites them wholesale.
    //
    // The test is "did any call site get attempted", NOT "is the array empty".
    // `languageKindTally` (resolution-runner.ts) registers a language once per
    // WALKED FILE, before the per-call loop, so a run over files that contain no
    // calls at all yields a full set of ALL-ZERO rows — non-empty, yet carrying
    // no measurement. An emptiness check passes those straight through to the
    // DELETE. Observed live on 2026-08-11 (bd tea-rags-mcp-snbzk): consecutive
    // runs alternated between a full breakdown and no section at all.
    if (!rows.some((r) => r.attempted > 0)) return;
    await graphDb.recordRunStats(rows);
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
   * Worker-pool collection release hook. Phase 2 of the unified-enrichment-
   * worker-pool plan: `EnrichmentCoordinator.awaitCompletion(collection)`
   * fires `executor.releaseCollection(collection)` after all markers reach
   * healthy. The worker pool forwards the release envelope to the pinned
   * worker thread, which calls this hook on the cached provider and then
   * evicts the cache entry.
   *
   * Scope: this provider instance owns state for a single (collection,
   * worker) pair on the worker pool's affinity binding (see
   * `WorkerPool.dispatch(req, routingKey)`). Releasing all per-run maps
   * + the per-collection `chunkSymbolByLine` entry is correct because the
   * worker will not be asked to serve that collection again on this
   * cached instance — the next index pass rebuilds a fresh provider.
   *
   * Failure mode: a throw here is swallowed by the worker (bounded memory
   * wins over perfect cleanup). The daemon DuckDB connection is
   * multi-client by design so a stale handle is harmless; on next index
   * pass the rebuilt provider opens a fresh socket connection.
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
   * Recursively enumerate supported-language files under `root`. Two
   * ignore layers applied per entry:
   *
   *   Layer 1 — `scannerIgnoreFilter` (optional, from FileScanner via
   *             `FileSignalOptions.ignoreFilter`). Same filter the main
   *             ingest path uses: BUILTIN_IGNORE_PATTERNS + user
   *             `.gitignore` / `.contextignore`. Catches `node_modules/`,
   *             `_nuxt/`, `vendor/bundle/`, glob patterns like
   *             `*.min.js`, AND project-specific user rules.
   *   Layer 2 — `this.codegraphExclusionFilter` (always present). Carries
   *             CODEGRAPH_GENERATED_PATTERNS + CODEGRAPH_TEST_PATTERNS
   *             unconditionally, each language's own non-app-code globs, plus
   *             any `CODEGRAPH_CUSTOM_EXCLUDE` patterns.
   *
   * Directory-level early skip on both layers is a performance
   * optimisation — `ignore` resolves trailing-slash patterns
   * (`node_modules/`) against the dir path so we can skip recursion
   * entirely instead of walking thousands of children just to filter
   * them out file-by-file.
   *
   * Returns repo-relative POSIX paths.
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
        // Hidden dotfiles still get pruned at the codegraph layer — the
        // FileScanner filter doesn't carry a blanket dotfile rule
        // (BUILTIN_IGNORE_PATTERNS only lists specific dotted entries
        // like `.git/`, `.DS_Store`). Preserve `.claude-plugin/` as the
        // one allowed exception because it ships shipped plugin source.
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

  /**
   * Parse a single file from disk and produce a `FileExtraction`
   * matching the chunker's symbol shape. Dispatches by file extension
   * to the appropriate language config (parser + walker + symbol
   * collector). The chunker proper applies richer hooks (class-body,
   * test-DSL, oversized split) — codegraph needs only the top-level
   * symbol identifiers, so a simple per-language walker over
   * function/method/class declarations is sufficient.
   */
  private extractOneFile(root: string, relPath: string): FileExtraction {
    const ext = extensionOf(relPath);
    const langConfig = CODEGRAPH_LANGUAGES[ext];
    if (!langConfig) {
      // discoverSupportedFiles already filters by SUPPORTED_EXTS; this
      // is a defensive guard for callers that pass paths directly.
      return { relPath, language: "", imports: [], chunks: [], fileScope: [] };
    }
    // Walker capability (walk + nameOf) comes from the injected LanguageFactoryDescriptor
    // — keyed by language NAME (not extension). Parser-load + scopeSeparator +
    // disambiguateOverloads stay sourced from CODEGRAPH_LANGUAGES (kept in place
    // for this slice). The factory's walker is the legacy adapter's faithful
    // wrap of the SAME CODEGRAPH_LANGUAGES walk/nameOf, so output is unchanged.
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
    // Materialize the native tree immediately after parse so all downstream
    // consumers (collectSymbols + walker.walk) see the deterministic plain-JS
    // AstNode tree. Mirrors the chunker boundary (rdv7d fix for the incremental
    // reindex_changes path).
    const nativeTree = parser.parse(code);
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
    });
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const { graphDb } = await this.getStore(options?.collectionName);
    // Batched read-back (replaces the former per-chunk getCalledByCount +
    // getCallSiteCount + getPageRank N+1 — 3 serial IPC+SQL round-trips per
    // chunk over the daemon socket): one set-based fetch of every symbol's
    // {fanIn, fanOut, pageRank}, then an in-memory lookup per chunk. Values are
    // identical to the point getters (a symbol absent from the map is {0,0,0}).
    const bulkStartMs = isDebug() ? Date.now() : 0;
    const chunkSignals = await graphDb.getChunkSignalsBulk();
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_CHUNK_SIGNALS_READ", {
        symbols: chunkSignals.size,
        durationMs: Date.now() - bulkStartMs,
      });
    }
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const [relPath, entries] of chunkMap) {
      const perChunk = new Map<string, ChunkSignalOverlay>();
      for (const entry of entries) {
        // ChunkLookupEntry only carries chunkId + startLine/endLine;
        // resolveChunkSymbolId pulls symbolId from the walker-indexed
        // line map (populated when the same provider walked the file
        // in buildFileSignals). If file isn't in the map (e.g. older
        // chunks from before codegraph wiring, or non-TS files), skip.
        const symbolId = this.resolveChunkSymbolId(options?.collectionName, relPath, entry.startLine, entry.endLine);
        if (!symbolId) continue;
        // Confidence-weighted fanIn/fanOut (bd tea-rags-mcp-s5ato — fractional
        // under dynamic/cone fan-out, integer for exact edges) + per-symbol
        // PageRank from cg_symbols_metrics (0 when the symbol isn't in the table
        // yet). Read from the bulk map; a missing symbol ⇒ {0,0,0}, identical to
        // the point getters. Bare inner keys (tea-rags-mcp-k6xu) under
        // providerKey `codegraph.symbols.chunk` → `…chunk.fanIn`.
        const sig = chunkSignals.get(symbolId);
        perChunk.set(entry.chunkId, {
          fanIn: sig?.fanIn ?? 0,
          fanOut: sig?.fanOut ?? 0,
          pageRank: sig?.pageRank ?? 0,
        });
      }
      // 0rskm — store-time symbol→covering-chunk join. The walker's per-file
      // line map (relPath → startLine → symbolId) holds EVERY extracted symbol,
      // including methods of a collapsed class that got no own Qdrant chunk.
      // Invert it to symbol→startLine, run the containment join against this
      // file's chunk entries, and backfill cg_symbols.chunk_id.
      const lineMap = this.chunkSymbolByLine.get(this.collectionKey(options?.collectionName))?.get(relPath);
      if (lineMap && lineMap.size > 0) {
        const symbolStartLines = new Map<SymbolId, number>();
        for (const [startLine, symbolId] of lineMap) {
          symbolStartLines.set(symbolId, startLine);
        }
        const chunkIds = computeSymbolChunkIds(symbolStartLines, entries);
        if (chunkIds.size > 0) {
          await graphDb.updateSymbolChunkIds(relPath, chunkIds);
        }
      }
      out.set(relPath, perChunk);
    }
    return out;
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
 * Per-language `nameOf` functions: NONE remain here. ALL source languages —
 * TypeScript (`tsNameOf`), JavaScript (`jsNameOf` + its CommonJS helper web),
 * Ruby (`rbNameOf`), Python (`pyNameOf`), Go (`goNameOf` + its
 * `extractGoReceiverType` helper), Java (`javaNameOf`), Rust (`rustNameOf` + its
 * `stripRustGenerics` helper) and Bash (`bashNameOf`, the LAST one) — migrated
 * to native `domains/language/<lang>` providers (tea-rags-mcp-cen6); the engine
 * reads each one's `nameOf` from `factory.create(lang).walker.nameOf`. Markdown
 * stays doc-only via the legacy adapter (chunker-only, no walker / nameOf — it
 * has no `CODEGRAPH_LANGUAGES` entry). `methodKindFromClassify` is GONE too — the
 * native walkers reuse the kernel copy at
 * `domains/language/kernel/method-kind.ts`. The `classifyMethod` import is
 * likewise gone: bash's `nameOf` (its last in-file user) never needed it (bash
 * has no method concept), and the rust step already removed the helper.
 */

/**
 * Slice 2 helper — drain `graphDb.streamAdjacency(scope)` into the
 * compact `Map<string, string[]>` shape that `tarjanScc` and
 * `pageRank` consume. Differs from the legacy `listAdjacency` only in
 * that the adapter no longer pre-bucketed the rows; we build the Map
 * exactly once here. The per-edge confidence (third stream element,
 * method scope only — bd tea-rags-mcp-s5ato) is bucketed into an
 * index-aligned weight map for the weighted PageRank pass; absent
 * weights (file scope, legacy rows) default to 1. Mirrors the daemon
 * copy in `adapters/duckdb/daemon/server.ts`.
 */
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
