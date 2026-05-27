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
import { once } from "node:events";
import { createReadStream, createWriteStream, readdirSync, readFileSync, type Dirent, type WriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
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
  CallResolver,
  DispatchTableDef,
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
  NamedSymbol,
} from "../../../../contracts/types/codegraph.js";
import type { LanguageFactory, SymbolIdComposer } from "../../../../contracts/types/language.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOptions,
  ChunkSignalOverlay,
  DeletedPathOptions,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
  FilterDescriptor,
  ProviderRunMetrics,
} from "../../../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../../../contracts/types/reranker.js";
import {
  classifyMethod,
  INSTANCE_METHOD_SEPARATOR as INFRA_INSTANCE_METHOD_SEPARATOR,
} from "../../../../infra/symbolid/index.js";
import { extractFromBashFile } from "../../../ingest/pipeline/chunker/extraction/bash-walker.js";
import { extractFromGoFile } from "../../../ingest/pipeline/chunker/extraction/go-walker.js";
import { extractFromJavaFile } from "../../../ingest/pipeline/chunker/extraction/java-walker.js";
import { extractFromJavascriptFile } from "../../../ingest/pipeline/chunker/extraction/javascript-walker.js";
import { extractFromPythonFile } from "../../../ingest/pipeline/chunker/extraction/python-walker.js";
import { extractFromRustFile } from "../../../ingest/pipeline/chunker/extraction/rust-walker.js";
import { pipelineLog } from "../../../ingest/pipeline/infra/debug-logger.js";
import {
  CodegraphCheckpointError,
  CodegraphMetricsError,
  CodegraphResolveError,
  CodegraphSpillIoError,
} from "../../errors.js";
import { buildCodegraphExclusionFilter, type CodegraphExclusionOptions } from "../exclusion.js";
import { pageRank } from "../infra/page-rank.js";
import { tarjanScc } from "../infra/tarjan-scc.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";

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
 *             dilutes hub/PageRank signals). Default `excludeTests:true`
 *             keeps the graph clean.
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
 * Re-export the universal separator from infra so callers within this
 * file (joinSymbol) read the same constant without an extra import in
 * the body. See `.claude/rules/symbolid-convention.md`.
 */
const INSTANCE_METHOD_SEPARATOR = INFRA_INSTANCE_METHOD_SEPARATOR;

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
 * `NamedSymbol` is defined in `contracts/types/codegraph.js` and imported
 * above — relocated there so the per-language `LanguageWalker` interface can
 * reference it without a domain→domain import.
 */

/**
 * Compose the next fully-qualified id by appending `child.name` to
 * `composed` with the correct separator:
 *   - Top-level (`composed === ""`) → just the name.
 *   - `methodKind: "instance"` → `composed#child.name` (any language).
 *   - `methodKind: "static"`   → `composed.child.name` (any language).
 *   - Otherwise → `composed{scopeSeparator}child.name` (language-local).
 *
 * Behaviour-preserving delegation to the injected `SymbolIdComposer` — the one
 * cross-language symbolId mapper (spec §1a). The `{ methodKind, scopeSeparator,
 * absolute }` mapping is exactly the `compose` contract; this wrapper only
 * unpacks `NamedSymbol` into the option fields.
 */
function joinSymbol(composer: SymbolIdComposer, composed: string, child: NamedSymbol, scopeSeparator: string): string {
  return composer.compose(composed, child.name, {
    methodKind: child.methodKind,
    scopeSeparator,
    absolute: child.absolute,
  });
}

/**
 * Per-language extraction dispatch table. Codegraph walks any file
 * whose extension appears here. The walker emits a FileExtraction; the
 * symbol collector pulls top-level symbols out of the parsed tree.
 *
 * Adding a language: add a tree-sitter parser to deps, create a walker
 * in ingest/pipeline/chunker/extraction/, drop a row here.
 *
 * Exported (as `CodegraphLanguageConfig`) so the composition-layer
 * `legacyLanguageRegistry` (api/internal/) can wrap the per-extension
 * walker/nameOf into a `LanguageProvider.walker` without relocating this
 * map. The `domains/language` consolidation later moves each language's
 * walker into its native provider (spec §3). bd tea-rags-mcp-cat4.
 */
export interface CodegraphLanguageConfig {
  language: string;
  loadParser: () => Parser.Language;
  /**
   * Per-file extraction walker. OPTIONAL: a language migrated to a native
   * `domains/language/<lang>` provider (Ruby — tea-rags-mcp-cen6) drops its
   * `walker`/`nameOf` here because the provider supplies them via the injected
   * `LanguageFactory` (`extractOneFile` reads `factory.create(lang).walker`).
   * The entry is retained for `loadParser` / `scopeSeparator` /
   * `disambiguateOverloads`, which still source from this map. Non-migrated
   * languages keep both (the legacy adapter wraps them).
   */
  walker?: (input: {
    tree: Parser.Tree;
    code: string;
    relPath: string;
    language: string;
    chunks: { symbolId: string; startLine: number; endLine: number; scope: string[] }[];
  }) => FileExtraction;
  /**
   * Maps a tree-sitter node to a `NamedSymbol` descriptor. Returns
   * null for nodes that are not top-level symbols. `descendsInto: true`
   * means the walker recurses into the node's children with extended
   * scope (e.g. class bodies whose methods become nested symbols).
   * `instanceMethod: true` flags methods that are invoked on an
   * instance (NOT class methods, NOT static methods, NOT abstract).
   * When true and the immediate parent is a class scope, the symbol id
   * uses the `#` separator per the project-wide convention; otherwise
   * the language's `scopeSeparator` is used. See
   * `.claude/rules/symbolid-convention.md` for the full table.
   */
  /**
   * Most languages emit zero or one symbol per AST node. Ruby DSL macros
   * (`attr_accessor :a, :b`) emit MULTIPLE symbols from a single `call`
   * node — returning an array tells `collectSymbols` to emit each
   * synthetic symbol at the same scope (no descent, no scope mutation).
   * Array members MUST have `descendsInto: false`; the array form is for
   * leaf methods only.
   */
  nameOf: (node: Parser.SyntaxNode) => NamedSymbol | NamedSymbol[] | null;
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
  ".ts": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).typescript,
    // walker DROPPED — typescript migrated to the native domains/language/typescript
    // provider (tea-rags-mcp-cen6). The engine reads `walk`/`nameOf` from
    // `factory.create("typescript").walker`; this entry is retained only for
    // `loadParser` (the `.typescript` grammar) / `scopeSeparator`, still sourced
    // from the map so the per-extension grammar choice for `.ts` vs `.tsx` stays
    // here. The local `nameOf: tsNameOf` is kept to satisfy the non-optional
    // config field AND because `jsNameOf` (used by the still-legacy `.js`/`.jsx`/
    // `.mjs`/`.cjs` entries) delegates to it — so `tsNameOf` is NOT dead; it is
    // simply no longer the source the engine reads for typescript files.
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).tsx,
    // walker DROPPED — see the `.ts` entry. `loadParser` here selects the `.tsx`
    // grammar (the one difference between the two extensions); the native
    // provider's single walker handles both grammars' node types.
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".py": {
    language: "python",
    loadParser: () => PyLang as Parser.Language,
    walker: extractFromPythonFile,
    nameOf: pyNameOf,
    scopeSeparator: ".",
  },
  ".rb": {
    language: "ruby",
    loadParser: () => RbLang as Parser.Language,
    // walker DROPPED — ruby migrated to the native domains/language/ruby
    // provider (tea-rags-mcp-cen6). The engine reads `walk`/`nameOf` from
    // `factory.create("ruby").walker`; this entry is retained only for
    // `loadParser` / `scopeSeparator` (still sourced from the map). The local
    // `nameOf` is kept to satisfy the non-optional config field but is no
    // longer read by the engine for ruby.
    nameOf: rbNameOf,
    scopeSeparator: "::",
  },
  // JavaScript variants share grammar node types for the ES2015 class
  // surface — function_declaration / method_definition / class_declaration
  // route through tsNameOf as in TypeScript. CommonJS / pre-class JS adds
  // a second surface (assignment_expression + lexical_declaration with a
  // function value); jsNameOf wraps tsNameOf and recognises those shapes.
  // Without it the walker missed ~96% of express OSS's symbol surface
  // (bd tea-rags-mcp-mwty — lib/application.js has ~30 `app.X = function`
  // definitions, only 2 were extracted).
  ".js": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: jsNameOf,
    scopeSeparator: ".",
  },
  ".jsx": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: jsNameOf,
    scopeSeparator: ".",
  },
  ".mjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: jsNameOf,
    scopeSeparator: ".",
  },
  ".cjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: jsNameOf,
    scopeSeparator: ".",
  },
  ".go": {
    language: "go",
    loadParser: () => GoLang as Parser.Language,
    walker: extractFromGoFile,
    nameOf: goNameOf,
    scopeSeparator: ".",
  },
  ".java": {
    language: "java",
    loadParser: () => JavaLang as Parser.Language,
    walker: extractFromJavaFile,
    nameOf: javaNameOf,
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
    walker: extractFromRustFile,
    nameOf: rustNameOf,
    scopeSeparator: "::",
  },
  ".sh": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    walker: extractFromBashFile,
    nameOf: bashNameOf,
    scopeSeparator: ".",
  },
  ".bash": {
    language: "bash",
    loadParser: () => BashLang as Parser.Language,
    walker: extractFromBashFile,
    nameOf: bashNameOf,
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
  resolvers: Map<string, CallResolver>;
  /**
   * Per-language capability source (walker + resolver), injected via DI from
   * the composition layer (`api/internal/composition.ts` / `bootstrap/factory.ts`).
   * The provider reads `factory.create(lang).walker` (`walk`/`nameOf`) for the
   * symbol-collection pass and `.resolver` (`resolve`/`resolveDispatch`) for
   * pass-2 edge resolution — replacing its direct reads of the per-extension
   * `CODEGRAPH_LANGUAGES` walker fields and the `resolvers` map. Typed as the
   * contracts `LanguageFactory` interface; the concrete factory is never
   * imported here (leaf-domain guard forbids `trajectory/** -> domains/language/**`).
   * Parser-load / scopeSeparator / disambiguateOverloads are still sourced from
   * `CODEGRAPH_LANGUAGES` (kept in place per the consolidation slice plan).
   * bd tea-rags-mcp-cat4.
   */
  languageFactory: LanguageFactory;
  /**
   * Cross-language symbolId mapper used by `joinSymbol` to compose
   * fully-qualified ids per `.claude/rules/symbolid-convention.md`. Injected as
   * the contracts `SymbolIdComposer` interface (DI from bootstrap/api) — the
   * concrete `DefaultSymbolIdComposer` is never imported here (leaf-domain
   * guard forbids `trajectory/** -> domains/language/**`).
   */
  composer: SymbolIdComposer;
  /** Derived signals + presets are wired by `createSymbolsTrajectory` in T9. */
  derivedSignals?: DerivedSignalDescriptor[];
  presets?: RerankPreset[];
  /**
   * Codegraph-layer exclusion config — wired from
   * `codegraphSchema.excludeTests` + `codegraphSchema.customExcludePatterns`
   * by the bootstrap factory. Optional: tests/fixtures default to
   * `{ excludeTests: false, customPatterns: [] }` (no codegraph-layer
   * exclusions) for predictable behaviour without env wiring.
   */
  exclusion?: CodegraphExclusionOptions;
}

export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[] = [];
  readonly presets: RerankPreset[];

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
   * Per-run counters surfaced via `getRunMetrics()`. Read-and-cleared by
   * `CompletionRunner` at end of each enrichment cycle. Tracked here
   * (not in the sink) so they survive across multiple sink.write/finish
   * pairs within a single run (e.g. backfill paths).
   */
  private runStats = createEmptyRunStats();
  /**
   * Per-run aggregation of `FileExtraction.classAncestors` across every
   * file walked in pass-1. The resolver needs ancestors keyed by
   * `targetType` (the class a variable is bound to) — that target type's
   * declaration usually lives in a DIFFERENT file than the caller, so
   * per-file ancestor maps are insufficient. Reset on finish().
   */
  private runAncestors: Record<string, readonly string[]> = {};
  /**
   * Per-run aggregation of `FileExtraction.classPrependedAncestors`
   * (bd tea-rags-mcp-3jvn). Same lifecycle as `runAncestors` — merged
   * across pass-1 files, consumed by pass-2 resolver. Walked BEFORE the
   * bound class itself by `RubyCallResolver.resolveByLocalTypeInternal`
   * so prepended modules' methods shadow the class's own.
   */
  private runPrependedAncestors: Record<string, readonly string[]> = {};
  /**
   * Per-run aggregation of `FileExtraction.classExtends`
   * (bd tea-rags-mcp-d29r). Single-inheritance parent map merged across
   * pass-1 files so the resolver's `super()` branch can route to the
   * parent class regardless of which file declares it.
   */
  private runExtends: Record<string, string> = {};
  /**
   * Per-run aggregation of `FileExtraction.functionReturnTypes`
   * (bd tea-rags-mcp-6g9c). `functionName → declaredReturnTypeName` merged
   * across pass-1 files so the Go resolver can bind `x := New(); x.method()`
   * to `<New's return type>#method` even when `New` is declared in a
   * different file. Same lifecycle as `runExtends` — reset on finish().
   */
  private runReturnTypes: Record<string, string> = {};
  /**
   * Per-run aggregation of `FileExtraction.dispatchTables` keyed by table
   * NAME (bd tea-rags-mcp-n0zj). The value is a `DispatchTableDef[]` because
   * the same name may be declared in several files; the resolver
   * disambiguates by the caller's import map. Re-walking a file replaces its
   * own entry (dedup by relPath). Same lifecycle as `runExtends` —
   * reset on the empty-run path of `getRunMetrics`.
   */
  private runDispatchTables: Record<string, DispatchTableDef[]> = {};
  /**
   * Per-run aggregation of `FileExtraction.callbackParams` keyed by the
   * function/method symbolId (bd tea-rags-mcp-n0zj). Merged across pass-1
   * files so the resolver's bounded inter-procedural join sees a callee's
   * invoked param positions regardless of which file declared it.
   */
  private runCallbackParams: Record<string, number[]> = {};
  /**
   * Codegraph-layer ignore filter (Layer 2 in `discoverSupportedFiles`).
   * Built once at construction from `deps.exclusion`. Empty filter
   * (`excludeTests:false`, no custom patterns) is a valid no-op — every
   * `ignores()` call returns false and the layer becomes transparent.
   */
  private readonly codegraphExclusionFilter: Ignore;

  constructor(private readonly deps: CodegraphProviderDeps) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
    this.codegraphExclusionFilter = buildCodegraphExclusionFilter(
      deps.exclusion ?? { excludeTests: false, customPatterns: [] },
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
      return this.deps.pool.acquire(stripVersionSuffix(collectionName));
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
   * Build an `ExtractionSink` bound to the active collection. The sink
   * captures the per-collection (graphDb, symbolTable) pair so all
   * downstream `write`/`finish` calls land in the right DuckDB file.
   *
   * `collectionName` is optional in direct mode (test fixtures), but
   * MUST be supplied in pool mode (production bootstrap). The provider
   * fails loud at the first store-resolution otherwise.
   */
  asExtractionSink(collectionName?: string): ExtractionSink {
    // Slice 2 chunked-flush ingest. Three rules that replace the prior
    // "buffer until finish" model and lift the indexing memory ceiling:
    //
    // 1. Symbol definitions are persisted on EVERY write — to the
    //    in-memory `symbolTable` AND DuckDB via `upsertSymbols`. The
    //    resolver in pass-2 needs the full cross-file symbol set, so
    //    we cannot defer this to finish().
    // 2. The raw `FileExtraction` is appended to an NDJSON spill file
    //    on disk. JS heap only holds the current row; the parsed
    //    tree-sitter AST and intermediate buffers can be reclaimed
    //    immediately after this write returns. For ugnest-scale runs
    //    (5574 files) this is the load-bearing optimisation — the
    //    prior in-memory `FileExtraction[]` held every extraction's
    //    chunk/call arrays simultaneously.
    // 3. finish() drives `streamingResolveAndUpsert` which reads the
    //    spill back line-by-line, resolves calls, issues per-file
    //    upserts, and CHECKPOINTs every N files. This keeps the
    //    DuckDB WAL bounded throughout the pass.
    //
    // The spill path is `<dataDir>/codegraph/.spill/<coll>-<runId>.ndjson`
    // — `runId` from `randomUUID` so concurrent ingest passes (rare
    // but possible across collections) get unique files. Stale spill
    // files left by a prior crashed run are purged at pool init
    // (DuckDbGraphClient.init when `tempDirectory` is set).
    const runId = randomUUID();
    const spillPath = this.deps.pool
      ? this.deps.pool.spillPathFor(stripVersionSuffix(collectionName ?? "__direct__"), runId)
      : // Direct mode (tests) has no pool — keep spill colocated with
        // the test's working directory under a hidden subdir to avoid
        // polluting the project root.
        join(process.cwd(), ".tea-rags-codegraph-spill", `direct-${runId}.ndjson`);
    let spillStream: WriteStream | null = null;
    let spillWriteCount = 0;
    let finished = false;

    const ensureSpillStream = async (): Promise<WriteStream> => {
      if (spillStream) return spillStream;
      try {
        await mkdir(pathDirname(spillPath), { recursive: true });
        spillStream = createWriteStream(spillPath, { encoding: "utf8" });
      } catch (err) {
        throw new CodegraphSpillIoError(spillPath, "open", err instanceof Error ? err : undefined);
      }
      return spillStream;
    };

    const cleanupSpill = async (): Promise<void> => {
      // Best-effort: unlink the spill regardless of success/failure
      // so a failed run does not leak GBs of NDJSON. ENOENT means a
      // prior cleanup already happened (idempotent), all other errors
      // are swallowed because the pool init re-purges on next process
      // start anyway.
      await rm(spillPath, { force: true }).catch(() => undefined);
    };

    return {
      write: async (extraction) => {
        if (finished) {
          // Caller bug — write after finish. Surface as a programming
          // error so the test path catches it; typed error is overkill
          // for an invariant.
          throw new Error("CodegraphEnrichmentProvider sink: write() called after finish()");
        }
        const { graphDb, symbolTable } = await this.getStore(collectionName);
        const defs = extraction.chunks.map((c) => ({
          symbolId: c.symbolId,
          fqName: c.symbolId,
          shortName: lastSegment(c.symbolId),
          relPath: extraction.relPath,
          scope: c.scope,
        }));
        // Persist defs to both the in-memory table (for in-pass
        // resolver lookups) AND DuckDB (for cold-start hydration of a
        // later partial reindex). Streaming the symbols rather than
        // batching at finish means the resolver in pass-2 can resolve
        // calls into files that were walked earlier in pass-1 even
        // when those rows already landed; the in-memory table is the
        // source of truth during the run, DuckDB is the durable copy.
        symbolTable.upsertFile(extraction.relPath, defs);
        await graphDb.upsertSymbols(extraction.relPath, defs);
        this.indexChunkSymbolsByLine(collectionName, extraction);
        // Merge file-local ancestors into the run-global map so the
        // resolver in pass-2 sees ancestors keyed by target class
        // regardless of which file declared them. Last write wins on
        // duplicate keys — same-class declarations across files are
        // rare in Ruby; when they happen the later definition is what
        // the runtime would see too.
        if (extraction.classAncestors) {
          for (const [k, v] of Object.entries(extraction.classAncestors)) {
            this.runAncestors[k] = v;
          }
        }
        if (extraction.classPrependedAncestors) {
          for (const [k, v] of Object.entries(extraction.classPrependedAncestors)) {
            this.runPrependedAncestors[k] = v;
          }
        }
        if (extraction.classExtends) {
          for (const [k, v] of Object.entries(extraction.classExtends)) {
            this.runExtends[k] = v;
          }
        }
        // Merge file-local function return types into the run-global map so
        // the resolver in pass-2 can resolve `x := New()` return-type
        // bindings keyed by function name regardless of which file declares
        // the function. bd tea-rags-mcp-6g9c. Last write wins on duplicate
        // names; the resolver's symbol-table existence gate suppresses any
        // wrong type that survives the collision.
        if (extraction.functionReturnTypes) {
          for (const [k, v] of Object.entries(extraction.functionReturnTypes)) {
            this.runReturnTypes[k] = v;
          }
        }
        // Merge dispatch tables run-global keyed by table name + defining
        // relpath so the resolver can fan a `TABLE[key].field()` call out to
        // every candidate regardless of which file declared the table (bd
        // tea-rags-mcp-n0zj). Re-walking a file replaces its own def for that
        // name (dedup by relPath) — incremental reindex stays idempotent.
        if (extraction.dispatchTables) {
          for (const [name, table] of Object.entries(extraction.dispatchTables)) {
            const defs = (this.runDispatchTables[name] ??= []);
            const at = defs.findIndex((d) => d.relPath === extraction.relPath);
            if (at >= 0) defs[at] = { relPath: extraction.relPath, table };
            else defs.push({ relPath: extraction.relPath, table });
          }
        }
        // Merge callback-param maps run-global keyed by symbolId so the
        // bounded inter-proc join sees a callee's invoked param positions
        // even when the call site is in a different file.
        if (extraction.callbackParams) {
          for (const [symbolId, indices] of Object.entries(extraction.callbackParams)) {
            this.runCallbackParams[symbolId] = indices;
          }
        }

        const stream = await ensureSpillStream();
        const line = `${JSON.stringify(extraction)}\n`;
        const ok = stream.write(line);
        if (!ok) {
          // Back-pressure — wait for the drain event before the next
          // write returns. Prevents a fast walker from filling the
          // OS pipe and ballooning kernel buffers.
          try {
            await once(stream, "drain");
          } catch (err) {
            throw new CodegraphSpillIoError(spillPath, "write", err instanceof Error ? err : undefined);
          }
        }
        spillWriteCount += 1;
        this.runStats.extractedFiles += 1;
      },
      finish: async () => {
        finished = true;
        const streamToClose = spillStream;
        if (streamToClose) {
          // Close the writable end before the reader opens it. `end`
          // takes a callback and finishes the file with a final flush.
          await new Promise<void>((resolve, reject) => {
            streamToClose.end((err?: Error | null) => {
              if (err) reject(new CodegraphSpillIoError(spillPath, "write", err));
              else resolve();
            });
          });
        }
        try {
          if (spillWriteCount > 0) {
            await this.streamingResolveAndUpsert(spillPath, collectionName);
          }
          // Metric recompute is best-effort by contract: data integrity
          // is preserved by streamingResolveAndUpsert; only cycle /
          // pagerank freshness is at stake. A failure here degrades
          // find_cycles and rerank rather than aborting the index pass,
          // so we swallow CodegraphMetricsError after the debug log
          // the helper itself emits. Other error types (spill IO,
          // resolve) DO propagate from streamingResolveAndUpsert above.
          try {
            await this.recomputeGraphMetricsStreaming(collectionName);
          } catch (err) {
            if (!(err instanceof CodegraphMetricsError)) throw err;
          }
        } finally {
          await cleanupSpill();
        }
      },
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
    const { graphDb, symbolTable } = await this.getStore(collectionName);
    const CHECKPOINT_EVERY = 500;
    const PROGRESS_EVERY = 100;
    // Cardinality cap per single upsertFile transaction. Minified
    // JS/TS bundles (Vite/Nuxt/Webpack build artefacts that should
    // really live behind .gitignore but sometimes don't) can produce
    // tens of thousands of method edges in one file — DuckDB blows
    // past its memory_limit trying to commit a single transaction with
    // that many INSERTs. Skipping these files is safe: a minified
    // bundle has no resolvable cross-file graph semantics anyway, and
    // letting one pathological row abort pass-2 wipes hours of work
    // for the entire project. Cap chosen by inspection of the ugnest
    // failure (file with 96k method edges OOM'd at 1.8GB).
    const MAX_EDGES_PER_FILE = 10000;
    let processed = 0;
    let lastRelPath: string | null = null;
    let reader: ReturnType<typeof createInterface> | null = null;
    try {
      reader = createInterface({
        input: createReadStream(spillPath, { encoding: "utf8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of reader) {
        if (!line) continue;
        let extraction: FileExtraction;
        try {
          extraction = JSON.parse(line) as FileExtraction;
        } catch (err) {
          throw new CodegraphResolveError(processed, err instanceof Error ? err : undefined);
        }
        lastRelPath = extraction.relPath;
        let edges: GraphEdges;
        try {
          edges = this.resolveExtraction(extraction, symbolTable);
        } catch (err) {
          // Per-file resolver throw — wrap with file context so the
          // marker / stderr surfaces "at file #N (relPath)" instead of
          // a bare position counter.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          throw new CodegraphResolveError(
            processed,
            Object.assign(wrapped, {
              message: `resolveExtraction failed at file #${processed + 1} (${lastRelPath}): ${wrapped.message}`,
            }),
          );
        }
        const totalEdges = edges.fileEdges.length + edges.methodEdges.length;
        if (totalEdges > MAX_EDGES_PER_FILE) {
          // Skip pathological files (typically minified JS bundles) but
          // record the skip so operators can surface them via marker
          // log. Graph remains consistent because no partial state
          // landed for this row.
          pipelineLog.enrichmentPhase("CODEGRAPH_PASS2_SKIPPED_LARGE_FILE", {
            processed: processed + 1,
            relPath: extraction.relPath,
            language: extraction.language,
            fileEdges: edges.fileEdges.length,
            methodEdges: edges.methodEdges.length,
            cap: MAX_EDGES_PER_FILE,
          });
          processed += 1;
          continue;
        }
        try {
          await graphDb.upsertFile({ relPath: extraction.relPath, language: extraction.language }, edges);
        } catch (err) {
          // Per-file upsert throw — DuckDB constraint / connection /
          // type error. Same wrap pattern as above.
          const wrapped = err instanceof Error ? err : new Error(String(err));
          throw new CodegraphResolveError(
            processed,
            Object.assign(wrapped, {
              message: `graphDb.upsertFile failed at file #${processed + 1} (${lastRelPath}, edges=${edges.fileEdges.length}+${edges.methodEdges.length}): ${wrapped.message}`,
            }),
          );
        }
        this.runStats.fileEdgeCount += edges.fileEdges.length;
        this.runStats.methodEdgeCount += edges.methodEdges.length;
        processed += 1;
        // Per-N debug log so a slow run shows where it stalled.
        if (processed % PROGRESS_EVERY === 0) {
          pipelineLog.enrichmentPhase("CODEGRAPH_PASS2_PROGRESS", {
            processed,
            lastRelPath,
            fileEdges: this.runStats.fileEdgeCount,
            methodEdges: this.runStats.methodEdgeCount,
          });
        }
        if (processed % CHECKPOINT_EVERY === 0) {
          try {
            await graphDb.checkpoint();
          } catch (err) {
            throw new CodegraphCheckpointError(err instanceof Error ? err : undefined);
          }
        }
      }
      if (processed > 0 && processed % CHECKPOINT_EVERY !== 0) {
        try {
          await graphDb.checkpoint();
        } catch (err) {
          throw new CodegraphCheckpointError(err instanceof Error ? err : undefined);
        }
      }
    } catch (err) {
      if (
        err instanceof CodegraphResolveError ||
        err instanceof CodegraphCheckpointError ||
        err instanceof CodegraphSpillIoError
      ) {
        throw err;
      }
      // Catch-all wrap: include last-seen file in the cause message so
      // the propagated marker tells the operator WHERE the loop tripped.
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new CodegraphResolveError(
        processed,
        Object.assign(wrapped, {
          message: `loop fatal after ${processed} files (last seen: ${lastRelPath ?? "<none>"}): ${wrapped.message}`,
        }),
      );
    } finally {
      reader?.close();
    }
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
    const { graphDb } = await this.getStore(collectionName);
    try {
      const fileAdj = await collectAdjacency(graphDb, "file");
      const fileSccs = tarjanScc(fileAdj);
      await graphDb.replaceCycles("file", fileSccs);

      const methodAdj = await collectAdjacency(graphDb, "method");
      const methodSccs = tarjanScc(methodAdj);
      await graphDb.replaceCycles("method", methodSccs);

      const rankResult = pageRank(methodAdj);
      await graphDb.replacePageRanks(rankResult.ranks);
    } catch (err) {
      // Non-fatal: data is consistent up to here, only metrics tables
      // may be stale. Surface as a typed error so the caller's debug
      // log carries the stage; the prefetch path catches and proceeds.
      if (process.env.DEBUG === "true") {
        process.stderr.write(`[codegraph] post-extract metric recompute failed: ${(err as Error).message}\n`);
      }
      throw new CodegraphMetricsError(
        err instanceof CodegraphMetricsError ? "pagerank" : "tarjan",
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * Per-run counters for `EnrichmentMetrics.byProvider["codegraph.symbols"]`.
   * Read-and-clear: returning the snapshot resets internal state so the
   * next enrichment cycle starts at zero. CompletionRunner calls this
   * once per cycle.
   */
  getRunMetrics(): ProviderRunMetrics | undefined {
    const { extractedFiles, fileEdgeCount, methodEdgeCount, callsAttempted, callsResolved } = this.runStats;
    if (extractedFiles === 0 && fileEdgeCount === 0 && methodEdgeCount === 0) {
      this.runStats = createEmptyRunStats();
      this.runAncestors = {};
      this.runPrependedAncestors = {};
      this.runExtends = {};
      this.runReturnTypes = {};
      this.runDispatchTables = {};
      this.runCallbackParams = {};
      return undefined;
    }
    const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / callsAttempted;
    this.runStats = createEmptyRunStats();
    this.runAncestors = {};
    this.runPrependedAncestors = {};
    return { extractedFiles, fileEdgeCount, methodEdgeCount, resolveSuccessRate };
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
    // graph despite `excludeTests:true`. The standalone-walk branch
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

    // Collection-wide p95 of fanIn, finalising `isHub` at index time. Read
    // from the full graph in DuckDB (NOT the in-memory overlay subset):
    // on incremental reindex `overlayPaths` holds only the changed files,
    // so computing the percentile from that subset would misclassify hubs.
    // The first pass above has just brought the whole graph up to date, so
    // the DB query naturally spans the entire collection's file universe.
    const fanInP95 = await graphDb.getFanInP95();

    // Second pass: emit the metric overlays per file. We emit a row for
    // every relPath the caller listed (or every file we walked), so the
    // enrichment coordinator sees a consistent overlay map shape.
    const overlayPaths = options?.paths && options.paths.length > 0 ? options.paths : targetRelPaths;
    const result = new Map<string, FileSignalOverlay>();
    for (const relPath of overlayPaths) {
      const fanIn = await graphDb.getFanIn(relPath);
      const fanOut = await graphDb.getFanOut(relPath);
      const denom = fanIn + fanOut;
      // Slice 2 / B1 — transitive blast radius via reverse BFS over
      // file edges. Depth defaults to 5 (in DuckDB client). Cheap on
      // small files (early-empty); on hub files the DuckDB recursive
      // CTE handles up to ~thousands of ancestors comfortably.
      const transitiveImpact = await graphDb.getTransitiveImpact(relPath);
      // Bare inner keys (tea-rags-mcp-k6xu). EnrichmentApplier writes this
      // overlay under providerKey `codegraph.symbols.file`, which Qdrant
      // resolves as a path. Bare keys mean the on-disk shape is
      // `codegraph.symbols.file.fanIn` (single prefix), natively addressable
      // by Qdrant filters — mirroring git's `git.file.commitCount`. A dotted
      // inner key would produce a literal leaf `"codegraph.file.fanIn"` that
      // Qdrant cannot reach via a filter path.
      result.set(relPath, {
        fanIn,
        fanOut,
        instability: denom === 0 ? 0 : fanOut / denom,
        // Support signal for instability.confidence — derived inline so
        // bytes hit Qdrant in the same payload as fanIn/fanOut.
        connectionCount: denom,
        // isHub = fanIn above the collection-wide p95. Computed here at
        // index time (p95 queried once above against the full graph), so
        // the persisted payload boolean is truthful. IsHubSignal reads
        // this boolean verbatim — there is no rerank-time finalisation.
        isHub: fanIn > fanInP95,
        isLeaf: fanOut === 0 && fanIn > 0,
        transitiveImpact,
      });
    }
    return result;
  }

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
   *   Layer 2 — `this.codegraphExclusionFilter` (always present;
   *             empty filter is the no-op case). Carries
   *             CODEGRAPH_TEST_PATTERNS when `excludeTests:true` plus
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
    // Walker capability (walk + nameOf) comes from the injected LanguageFactory
    // — keyed by language NAME (not extension). Parser-load + scopeSeparator +
    // disambiguateOverloads stay sourced from CODEGRAPH_LANGUAGES (kept in place
    // for this slice). The factory's walker is the legacy adapter's faithful
    // wrap of the SAME CODEGRAPH_LANGUAGES walk/nameOf, so output is unchanged.
    const walker = this.deps.languageFactory.create(langConfig.language).walker;
    if (!walker) {
      // Defensive: a code language always has a walker (markdown — the only
      // walker-less provider — has no CODEGRAPH_LANGUAGES entry, so we never
      // reach here for it). Return an empty extraction rather than throw.
      return { relPath, language: langConfig.language, imports: [], chunks: [], fileScope: [] };
    }
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(langConfig.loadParser());
    const tree = parser.parse(code);
    const chunks = this.collectSymbols(
      tree,
      walker.nameOf,
      langConfig.scopeSeparator,
      langConfig.disambiguateOverloads ?? false,
    );
    return walker.walk({
      tree,
      code,
      relPath,
      language: langConfig.language,
      chunks,
    });
  }

  private collectSymbols(
    tree: Parser.Tree,
    nameOf: (node: Parser.SyntaxNode) => NamedSymbol | NamedSymbol[] | null,
    separator: string,
    disambiguateOverloads: boolean,
  ): { symbolId: string; startLine: number; endLine: number; scope: string[] }[] {
    const out: { symbolId: string; startLine: number; endLine: number; scope: string[] }[] = [];
    const walk = (node: Parser.SyntaxNode, scope: string[], composed: string): void => {
      const result = nameOf(node);
      // Stable nested-scope tracking lets each named declaration carry
      // a unique fully-qualified id even when same-name declarations
      // are nested in different parents (e.g. four `worker()` helpers
      // inside different outer functions). The string `composed` is
      // the fqName we've built so far; we extend it per-named symbol
      // with the right separator (`#` for instance methods nested
      // under a class; the language's `scopeSeparator` otherwise).
      //
      // Array return form (Ruby DSL macros): emit each synthetic symbol
      // at the current scope but do NOT descend through them — the
      // call node itself has no useful interior for walking.
      if (Array.isArray(result)) {
        for (const ns of result) {
          out.push({
            symbolId: joinSymbol(this.deps.composer, composed, ns, separator),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            scope,
          });
        }
        // Continue walking children at the SAME scope (descendsInto is
        // structurally false for array members — the call node is a leaf
        // for symbol purposes; its children are argument expressions
        // already covered by other nodes' nameOf).
        for (const child of node.children) walk(child, scope, composed);
        return;
      }
      const named = result;
      const childScope = named ? [...scope, named.name] : scope;
      const childComposed = named ? joinSymbol(this.deps.composer, composed, named, separator) : composed;
      if (named) {
        out.push({
          symbolId: childComposed,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scope,
        });
      }
      // Snapshot length BEFORE walking children so we can detect whether
      // the child walk emitted an explicit `<class>#constructor` symbol.
      // Used only when `syntheticConstructorIfMissing` is set (TS/JS
      // class_declaration — bd tea-rags-mcp-vw1u).
      const beforeChildren = out.length;
      for (const child of node.children) walk(child, childScope, childComposed);
      if (named?.syntheticConstructorIfMissing) {
        const expectedCtor = `${childComposed}#constructor`;
        let hasExplicit = false;
        for (let i = beforeChildren; i < out.length; i++) {
          if (out[i].symbolId === expectedCtor) {
            hasExplicit = true;
            break;
          }
        }
        if (!hasExplicit) {
          out.push({
            symbolId: expectedCtor,
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            scope: childScope,
          });
        }
      }
    };
    walk(tree.rootNode, [], "");
    // Default behaviour: dedup by symbolId (keep first occurrence). Used
    // by TS get/set accessor pairs (semantically one property), Python
    // `@functools.singledispatch` stubs (bd tea-rags-mcp-d4ab — keep
    // the first def, drop the impl-stub collision), etc.
    //
    // bd tea-rags-mcp-a466 — `disambiguateOverloads` opts a language IN
    // to overload-aware suffixing: keep the FIRST occurrence's symbolId
    // verbatim, append `~N` (1-based — second becomes `~2`) to each
    // duplicate. Java needs this because `find_symbol("StringUtils.upperCase")`
    // otherwise collapses multi-overload public APIs into a single
    // merged chunk and `get_callers`/`get_callees` can't disambiguate
    // which overload was called. Mirrors the chunker convention so
    // cg_symbols + Qdrant payload agree on the same physical AST node.
    if (disambiguateOverloads) {
      const occurrences = new Map<string, number>();
      return out.map((s) => {
        const seen = occurrences.get(s.symbolId) ?? 0;
        const next = seen + 1;
        occurrences.set(s.symbolId, next);
        if (next === 1) return s;
        return { ...s, symbolId: `${s.symbolId}~${next}` };
      });
    }
    const seen = new Set<string>();
    return out.filter((s) => {
      if (seen.has(s.symbolId)) return false;
      seen.add(s.symbolId);
      return true;
    });
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const { graphDb } = await this.getStore(options?.collectionName);
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
        const fanIn = await graphDb.getCalledByCount(symbolId);
        const fanOut = await graphDb.getCallSiteCount(symbolId);
        // Slice 2 / B3 — per-symbol PageRank from cg_symbols_metrics
        // (populated by recomputePageRank at sink.finish). Returns 0
        // when the symbol isn't in the table yet (first index pass
        // before recompute completes, or non-TS chunks without
        // extraction edges).
        const pageRankValue = await graphDb.getPageRank(symbolId);
        // Bare inner keys (tea-rags-mcp-k6xu) — written under providerKey
        // `codegraph.symbols.chunk`, so the addressable path is
        // `codegraph.symbols.chunk.fanIn`. See buildFileSignals for rationale.
        perChunk.set(entry.chunkId, {
          fanIn,
          fanOut,
          pageRank: pageRankValue,
        });
      }
      out.set(relPath, perChunk);
    }
    return out;
  }

  private resolveExtraction(extraction: FileExtraction, symbolTable: GlobalSymbolTable): GraphEdges {
    // Resolver capability comes from the injected LanguageFactory (keyed by
    // language NAME). The factory's resolver wraps the same CallResolver the
    // provider used to read from `deps.resolvers`, so resolution is unchanged;
    // `create` throws for unregistered languages, so gate on `supported()` first
    // (the defensive empty extraction emits `language: ""`, never registered).
    const resolver = this.deps.languageFactory.supported().includes(extraction.language)
      ? this.deps.languageFactory.create(extraction.language).resolver
      : undefined;
    const fileEdges: GraphEdges["fileEdges"] = [];
    const methodEdges: GraphEdges["methodEdges"] = [];
    if (!resolver) return { fileEdges, methodEdges };

    // Resolver receives the run-global `classAncestors` so it can walk
    // a bound type's inheritance chain regardless of which file
    // declares that class. Per-file ancestors are merged into
    // `this.runAncestors` during pass-1 (sink.write).
    const ancestorsForResolver =
      Object.keys(this.runAncestors).length > 0 ? this.runAncestors : extraction.classAncestors;
    const prependedAncestorsForResolver =
      Object.keys(this.runPrependedAncestors).length > 0
        ? this.runPrependedAncestors
        : extraction.classPrependedAncestors;
    const extendsForResolver = Object.keys(this.runExtends).length > 0 ? this.runExtends : extraction.classExtends;
    const returnTypesForResolver =
      Object.keys(this.runReturnTypes).length > 0 ? this.runReturnTypes : extraction.functionReturnTypes;
    // File-level edges from imports. We synthesise a "call-shaped" lookup
    // so the same resolver contract handles both call resolution and
    // import-to-file resolution.
    for (const imp of extraction.imports) {
      const last = lastSegment(imp.importText);
      const target = resolver.resolve(
        { callText: imp.importText, receiver: last, member: last, startLine: imp.startLine },
        {
          callerFile: extraction.relPath,
          callerScope: extraction.fileScope,
          imports: extraction.imports,
          symbolTable,
          classFieldTypes: extraction.classFieldTypes,
          classAncestors: ancestorsForResolver,
          classPrependedAncestors: prependedAncestorsForResolver,
          classExtends: extendsForResolver,
        },
      );
      if (target) {
        fileEdges.push({ targetRelPath: target.targetRelPath, importText: imp.importText });
      }
    }

    // Method-level edges from calls. Track resolve success ratio so the
    // run metrics surface how many call sites the resolver couldn't pin
    // to a target (low ratio = lots of dynamic / external calls).
    for (const chunk of extraction.chunks) {
      for (const call of chunk.calls) {
        this.runStats.callsAttempted += 1;
        const ctx = {
          callerFile: extraction.relPath,
          callerScope: chunk.scope,
          imports: extraction.imports,
          symbolTable,
          classFieldTypes: extraction.classFieldTypes,
          localBindings: chunk.localBindings,
          localCallBindings: chunk.localCallBindings,
          functionReturnTypes: returnTypesForResolver,
          classAncestors: ancestorsForResolver,
          classPrependedAncestors: prependedAncestorsForResolver,
          classExtends: extendsForResolver,
          // bd tea-rags-mcp-n0zj — run-global dispatch tables + callback
          // params drive the resolver's fan-out / inter-proc join.
          dispatchTables: this.runDispatchTables,
          callbackParams: this.runCallbackParams,
        };
        let resolved = false;
        if (call.dispatch) {
          // Dispatch call: fan out to candidates instead of normal
          // resolution. `sourceSymbolId: null` ⇒ the caller chunk.
          for (const edge of resolver.resolveDispatch?.(call, ctx) ?? []) {
            methodEdges.push({
              sourceSymbolId: edge.sourceSymbolId ?? chunk.symbolId,
              targetSymbolId: edge.targetSymbolId,
              targetRelPath: edge.targetRelPath,
              callExpression: call.callText,
            });
            resolved = true;
          }
        } else {
          const target = resolver.resolve(call, ctx);
          if (target) {
            methodEdges.push({
              sourceSymbolId: chunk.symbolId,
              targetSymbolId: target.targetSymbolId,
              targetRelPath: target.targetRelPath,
              callExpression: call.callText,
            });
            resolved = true;
          }
          // Bounded inter-proc join: a dispatch candidate-set passed as a
          // callback argument fans out from the CALLEE (non-null
          // sourceSymbolId on the edge), additive to the normal edge above.
          if (call.dispatchArgs && call.dispatchArgs.length > 0) {
            for (const edge of resolver.resolveDispatch?.(call, ctx) ?? []) {
              methodEdges.push({
                sourceSymbolId: edge.sourceSymbolId ?? chunk.symbolId,
                targetSymbolId: edge.targetSymbolId,
                targetRelPath: edge.targetRelPath,
                callExpression: call.callText,
              });
              resolved = true;
            }
          }
        }
        if (resolved) this.runStats.callsResolved += 1;
      }
    }

    return { fileEdges, methodEdges };
  }
}

interface RunStats {
  extractedFiles: number;
  fileEdgeCount: number;
  methodEdgeCount: number;
  callsAttempted: number;
  callsResolved: number;
}

function createEmptyRunStats(): RunStats {
  return { extractedFiles: 0, fileEdgeCount: 0, methodEdgeCount: 0, callsAttempted: 0, callsResolved: 0 };
}

function lastSegment(name: string): string {
  // Four callers with different separator conventions:
  //  - symbolIds like "Foo#bar" (instance) split on "#" → "bar"
  //  - symbolIds like "Foo.bar" (static / nested namespace) split on "." → "bar"
  //  - import paths like "../core/api/index.js" split on "/" → "index.js"
  //  - overload-disambiguated ids like "Foo.bar~2" (bd a466) — the
  //    `~N` suffix MUST be stripped before the last-segment cut so
  //    `lookupByShortName("bar")` matches every overload. Without the
  //    strip the short name would carry the suffix
  //    (`bar~2`) and shortName lookup would miss.
  // Path lookups must NOT split on "." or we'd return the extension
  // ("js") instead of the basename. Order is: "/" wins (path detection),
  // then "#" (instance method short-name), then "." (static / namespace
  // last component); finally strip any trailing `~N` arity suffix.
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  const hash = name.lastIndexOf("#");
  const segment =
    hash !== -1
      ? name.slice(hash + 1)
      : (() => {
          const dot = name.lastIndexOf(".");
          return dot === -1 ? name : name.slice(dot + 1);
        })();
  return segment.replace(/~\d+$/, "");
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

/**
 * Per-language `nameOf` functions. Each returns a `NamedSymbol`
 * descriptor or null. The instance/static classification routes
 * through `classifyMethod` in `core/infra/symbolid` — keeping the
 * chunker's payload-side symbolId AND the codegraph DB symbolId
 * derived from the SAME detection logic for any given AST node. See
 * `.claude/rules/symbolid-convention.md`.
 */

function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
}

function tsNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "method_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
    // bd tea-rags-mcp-vw1u — synthesize Class#constructor when no explicit
    // constructor is declared in the body. TS/JS classes without
    // `constructor() {}` still have an implicit constructor that
    // `new Class()` / `super()` resolve to; the synthetic keeps
    // resolver lookups consistent.
    //
    // bd tea-rags-mcp-q3o2 — tree-sitter-typescript emits
    // `abstract_class_declaration` (NOT `class_declaration`) for
    // `abstract class X {}`. Without this branch the walker skipped
    // abstract bases entirely: their members never reached cg_symbols,
    // children's `super(...)` calls resolved against an empty parent
    // entry, and `get_callers(AbstractBase#constructor)` returned `[]`
    // even though concrete subclasses called it. Same `childForFieldName`
    // shape, same class_body — the only difference is the keyword.
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true, syntheticConstructorIfMissing: true };
  }
  return null;
}

/**
 * JavaScript `nameOf` — delegates to `tsNameOf` for the ES2015 class
 * surface (function_declaration / method_definition / class_declaration)
 * and adds CommonJS / pre-class shapes that have no TypeScript analogue:
 *
 *   #1  obj.method = function () {}              → emit `obj.method`
 *   #2  Foo.prototype.bar = function () {}       → emit `Foo#bar` (instance)
 *   #3  exports.foo = function () {}             → emit top-level `foo`
 *   #4  module.exports = function name() {}      → emit top-level `name`
 *                                                  (skip if anonymous)
 *   #5  const Foo = function () {} | arrow       → emit `Foo` (also let / var)
 *   #6  res.a = res.b = function () {}           → emit BOTH res.a AND res.b
 *
 * The function lives next to `tsNameOf` so the symbolId composition stays
 * in one file (`.claude/rules/symbolid-convention.md` — single source of
 * truth). Returning a `NamedSymbol[]` for alias chains lets
 * `collectSymbols` emit each LHS target at the same scope without
 * descending through the function body twice.
 *
 * bd tea-rags-mcp-mwty.
 */
function jsNameOf(node: Parser.SyntaxNode): NamedSymbol | NamedSymbol[] | null {
  // Delegate first — TS-style declarations dominate modern JS too.
  const tsResult = tsNameOf(node);
  if (tsResult) {
    // bd tea-rags-mcp-mk45 — pre-ES6 constructor function pattern:
    //   function Foo(...) { this.x = ... }
    //   Foo.prototype.bar = function () {...}
    // The function_declaration alone looks like a plain top-level function;
    // the `Foo.prototype.X = fn` siblings are the strong signal that `Foo`
    // is a constructor. When detected, mark the function_declaration as a
    // synthetic-constructor source so the collector emits `Foo#constructor`.
    if (!Array.isArray(tsResult) && node.type === "function_declaration" && isJsConstructorFunction(node)) {
      return { ...tsResult, syntheticConstructorIfMissing: true };
    }
    return tsResult;
  }

  // Pattern #5: `const|let|var Foo = function () {}` / arrow / function name.
  // Wrapped in `lexical_declaration` (const/let) or `variable_declaration`
  // (var). We attach to the inner `variable_declarator` so each declarator
  // in a comma list (`const a = fn1, b = fn2`) is treated independently.
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) return null;
    if (nameNode.type !== "identifier") return null;
    if (!isFunctionValuedExpression(valueNode)) return null;
    return { name: nameNode.text, descendsInto: false };
  }

  // Patterns #1-#4, #6: `<lhs> = <function-valued rhs>`. The outermost
  // assignment_expression of a chain is what we descend on; chained inner
  // assignments are walked transitively via `collectAssignmentTargets`.
  // We only emit at the OUTER node so each chained LHS produces exactly
  // one symbol (the inner assignment_expression nodes return null at
  // their own visit).
  if (node.type === "assignment_expression") {
    // Skip if this assignment_expression is itself the RHS of another
    // assignment_expression — the outer visit will handle the whole chain.
    if (node.parent?.type === "assignment_expression") return null;
    const terminalRhs = walkAssignmentChainToTerminalRhs(node);
    if (!terminalRhs || !isFunctionValuedExpression(terminalRhs)) return null;
    const targets: NamedSymbol[] = [];
    collectAssignmentTargets(node, terminalRhs, targets);
    return targets.length === 0 ? null : targets.length === 1 ? targets[0] : targets;
  }

  // Pattern #7 (bd tea-rags-mcp-d1f8): JS getter helpers.
  //   Object.defineProperty(obj, 'name', { get: fn, set: fn })  → `<obj>.name`
  //   defineGetter(obj, 'name', fn)                              → `<obj>.name`
  // Both shapes are `call_expression`. Receiver text is taken verbatim
  // from the `<obj>` argument expression — when `obj` is the literal
  // `this`, the emitted name is `this.name` (resolving `this` to its
  // enclosing class would require additional scope tracking and is out
  // of scope for this fix).
  if (node.type === "call_expression") {
    const getter = jsGetterHelperEmission(node);
    if (getter) return getter;
    // Pattern #8 (bd tea-rags-mcp-z95o): HTTP-verb dispatch via
    //   <pkg>.forEach(function(<param>) { <obj>[<param>] = <fn>; });
    // where <pkg> resolves to the npm `methods` package via require().
    // Returns one NamedSymbol per HTTP verb; the array form tells
    // collectSymbols to emit each at the same scope.
    const dispatch = jsForEachDispatchEmission(node);
    if (dispatch) return dispatch;
  }

  return null;
}

/**
 * Recognise the `<methods>.forEach(method => obj[method] = fn)` HTTP-verb
 * dispatch pattern from express's `lib/application.js`.
 *
 * Returns one NamedSymbol per known HTTP verb (`<obj>.get`, `<obj>.post`, …)
 * — the array return form tells `collectSymbols` to emit each at the same
 * scope without descending.
 *
 * Conservative — only fires when:
 *   1. callee shape is `<recvIdent>.forEach(<fn-expr>)`.
 *   2. The argument is a `function_expression` / `arrow_function` with
 *      exactly one parameter (an identifier).
 *   3. The function body contains `<objIdent>[<paramName>] = <function-valued>`.
 *   4. At least ONE of the following HTTP-verb signals holds:
 *      a. `<recvIdent>` resolves via a sibling `require('methods')` (npm
 *         package), OR
 *      b. `<recvIdent>` is `methods` AND the file imports a local
 *         utility module whose path contains `util` (express does
 *         `var methods = require('./utils').methods`), OR
 *      c. The function body contains string-literal HTTP-verb comparisons
 *         like `method === 'get'` — the STRONGEST signal that the
 *         callback iterates HTTP verbs. Catches express directly
 *         regardless of the `methods` source.
 *
 * Generic case (arbitrary user array WITHOUT any HTTP-verb signal) is
 * structurally unresolvable without runtime info — out of scope.
 * bd tea-rags-mcp-z95o.
 */
function jsForEachDispatchEmission(node: Parser.SyntaxNode): NamedSymbol[] | null {
  const callee = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (!callee || !args) return null;
  if (callee.type !== "member_expression") return null;
  const recv = callee.childForFieldName("object");
  const method = callee.childForFieldName("property");
  if (!recv || !method) return null;
  if (recv.type !== "identifier") return null;
  if (method.type !== "property_identifier" || method.text !== "forEach") return null;

  const fnArg = args.namedChildren[0];
  if (!fnArg || !isFunctionValuedExpression(fnArg)) return null;
  const params = fnArg.childForFieldName("parameters");
  if (!params) return null;
  const paramIds = params.namedChildren.filter((c) => c.type === "identifier");
  if (paramIds.length !== 1) return null;
  const paramName = paramIds[0].text;

  const body = fnArg.childForFieldName("body");
  if (!body) return null;

  // Find the subscript assignment inside the body. Tree-sitter wraps it as
  // `expression_statement -> assignment_expression`.
  const assignment = findFirstSubscriptDispatchAssignment(body, paramName);
  if (!assignment) return null;
  const lhs = assignment.childForFieldName("left");
  if (lhs?.type !== "subscript_expression") return null;
  const objNode = lhs.childForFieldName("object");
  if (objNode?.type !== "identifier") return null;
  const objText = objNode.text;

  const root = findRoot(node);
  if (!root) return null;

  // Apply HTTP-verb signal heuristics — accept the dispatch if ANY holds.
  if (!hasHttpVerbDispatchSignal(root, recv.text, body, paramName)) return null;

  return HTTP_VERBS.map((verb) => ({ name: `${objText}.${verb}`, descendsInto: false }));
}

/**
 * Return true if the file (rooted at `root`) carries any signal that the
 * forEach receiver `recvName` iterates HTTP verbs. Three heuristics —
 * any one is sufficient (most specific first):
 *
 *   1. Body contains string-literal HTTP-verb comparisons like
 *      `<paramName> === 'get'`. Strongest — direct evidence the
 *      callback dispatches on HTTP verb tokens.
 *   2. `recvName === "methods"` AND a sibling require imports the npm
 *      `methods` package (`var methods = require('methods')`).
 *   3. `recvName === "methods"` AND a sibling require imports a local
 *      module whose path contains "util" (express does
 *      `var methods = require('./utils').methods`).
 *
 * bd tea-rags-mcp-z95o.
 */
function hasHttpVerbDispatchSignal(
  root: Parser.SyntaxNode,
  recvName: string,
  body: Parser.SyntaxNode,
  paramName: string,
): boolean {
  if (bodyComparesParamToHttpVerb(body, paramName)) return true;
  if (recvName === "methods") {
    const requireSource = findRequireSource(root, recvName);
    if (requireSource === "methods") return true;
    if (anyImportPathContainsUtil(root)) return true;
  }
  return false;
}

/**
 * Walk the function body looking for `<paramName> === <"http-verb">` or
 * `<"http-verb"> === <paramName>` binary expressions. Tree-sitter parses
 * `===` as `binary_expression` with operator child `===`. The string
 * argument must be one of HTTP_VERBS to count.
 */
function bodyComparesParamToHttpVerb(body: Parser.SyntaxNode, paramName: string): boolean {
  let found = false;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "binary_expression") {
      const op = n.childForFieldName("operator");
      const opText = op?.text ?? "";
      if (opText === "===" || opText === "==") {
        const left = n.childForFieldName("left");
        const right = n.childForFieldName("right");
        if (left && right) {
          if (isParamIdentifier(left, paramName) && isHttpVerbStringLiteral(right)) {
            found = true;
            return true;
          }
          if (isParamIdentifier(right, paramName) && isHttpVerbStringLiteral(left)) {
            found = true;
            return true;
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(body);
  return found;
}

function isParamIdentifier(n: Parser.SyntaxNode, paramName: string): boolean {
  return n.type === "identifier" && n.text === paramName;
}

function isHttpVerbStringLiteral(n: Parser.SyntaxNode): boolean {
  const s = readStringLiteral(n);
  if (s === null) return false;
  return (HTTP_VERBS as readonly string[]).includes(s.toLowerCase());
}

/**
 * Walk the program root and return true if any `variable_declarator`'s
 * RHS is a `require(<path>)` (or `require(<path>).<member>`) call where
 * the require'd path is a local file (starts with `./` or `../`) whose
 * filename contains `util`. Bonus heuristic for the
 * `var methods = require('./utils').methods` express pattern.
 */
function anyImportPathContainsUtil(root: Parser.SyntaxNode): boolean {
  let found = false;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "call_expression") {
      const callee = n.childForFieldName("function");
      const args = n.childForFieldName("arguments");
      if (callee?.type === "identifier" && callee.text === "require" && args) {
        const stringArg = args.namedChildren.find((c) => c.type === "string");
        if (stringArg) {
          const src = readStringLiteral(stringArg);
          if (src !== null && (src.startsWith("./") || src.startsWith("../")) && /util/i.test(src)) {
            found = true;
            return true;
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return found;
}

/**
 * The npm `methods` package — set of HTTP verbs Express dispatches.
 * Pinned to the historic list (express has always used these nine).
 * If the underlying npm package gains/loses verbs, this list stays a
 * conservative subset — extra walker symbols don't harm correctness;
 * missing ones simply revert to the pre-z95o behavior of "no symbol".
 */
const HTTP_VERBS = ["get", "post", "put", "delete", "head", "options", "patch", "connect", "trace"] as const;

/**
 * Walk `body` (a statement_block) and return the first
 * `assignment_expression` whose LHS is `<obj>[<paramName>]`. Used by the
 * forEach-dispatch detector to anchor the receiver-name extraction.
 */
function findFirstSubscriptDispatchAssignment(body: Parser.SyntaxNode, paramName: string): Parser.SyntaxNode | null {
  let found: Parser.SyntaxNode | null = null;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found) return true;
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      if (left?.type === "subscript_expression" && right && isFunctionValuedExpression(right)) {
        const idx = left.childForFieldName("index");
        if (idx?.type === "identifier" && idx.text === paramName) {
          found = n;
          return true;
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(body);
  return found;
}

/**
 * Walk `root` to find a `variable_declarator` of shape
 *   <recvName> = require('<source>')
 * and return the source string. Returns null if no such declarator
 * exists. Used to validate that a `forEach` receiver originates from
 * a known package.
 */
function findRequireSource(root: Parser.SyntaxNode, recvName: string): string | null {
  let found: string | null = null;
  const visit = (n: Parser.SyntaxNode): boolean => {
    if (found !== null) return true;
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const value = n.childForFieldName("value");
      if (name?.type === "identifier" && name.text === recvName && value?.type === "call_expression") {
        const callee = value.childForFieldName("function");
        const args = value.childForFieldName("arguments");
        if (callee?.type === "identifier" && callee.text === "require" && args) {
          const stringArg = args.namedChildren.find((c) => c.type === "string");
          if (stringArg) {
            const src = readStringLiteral(stringArg);
            if (src !== null) {
              found = src;
              return true;
            }
          }
        }
      }
    }
    for (const child of n.children) {
      if (visit(child)) return true;
    }
    return false;
  };
  visit(root);
  return found;
}

/**
 * Recognise the two project-supported "install a getter" shapes and
 * return a NamedSymbol for the installed name. Returns null for any
 * other call_expression.
 *
 * Shape A — `Object.defineProperty(<obj>, <"name">, { get: fn, ... })`.
 * The descriptor object must contain at least one `get:` or `set:`
 * function-valued pair; a plain `{ value: 1 }` descriptor is data, not
 * a callable, and is skipped.
 *
 * Shape B — `defineGetter(<obj>, <"name">, <fn>)`. Project-specific
 * helper (express `lib/request.js`); recognised by exact callee text
 * `defineGetter` and third argument being a function value.
 */
function jsGetterHelperEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  const callee = node.childForFieldName("function");
  const args = node.childForFieldName("arguments");
  if (!callee || !args) return null;
  const namedArgs = args.namedChildren;
  if (namedArgs.length < 3) return null;

  // Shape A: Object.defineProperty(obj, name, descriptor)
  if (callee.type === "member_expression") {
    const obj = callee.childForFieldName("object");
    const prop = callee.childForFieldName("property");
    if (
      obj?.type === "identifier" &&
      obj.text === "Object" &&
      prop?.type === "property_identifier" &&
      prop.text === "defineProperty"
    ) {
      const receiver = namedArgs[0];
      const nameArg = namedArgs[1];
      const descriptor = namedArgs[2];
      if (!receiver || !nameArg || !descriptor) return null;
      const propName = readStringLiteral(nameArg);
      if (!propName) return null;
      if (descriptor.type !== "object") return null;
      if (!objectHasGetterPair(descriptor)) return null;
      const receiverText = resolveReceiverText(receiver);
      if (!receiverText) return null;
      // `absolute: true` when receiver was `this` and we rewrote it via
      // enclosing-assignment lookup — the emitted name is the FULLY
      // resolved sibling of the outer assignment target, not a child of
      // the enclosing function's scope. bd tea-rags-mcp-d1f8 this-resolve.
      const absolute = receiver.type === "this";
      return { name: `${receiverText}.${propName}`, descendsInto: false, absolute };
    }
  }

  // Shape B: defineGetter(obj, name, fn) — project-specific helper.
  if (callee.type === "identifier" && callee.text === "defineGetter") {
    const receiver = namedArgs[0];
    const nameArg = namedArgs[1];
    const fnArg = namedArgs[2];
    if (!receiver || !nameArg || !fnArg) return null;
    const propName = readStringLiteral(nameArg);
    if (!propName) return null;
    if (!isFunctionValuedExpression(fnArg)) return null;
    const receiverText = resolveReceiverText(receiver);
    if (!receiverText) return null;
    const absolute = receiver.type === "this";
    return { name: `${receiverText}.${propName}`, descendsInto: false, absolute };
  }

  return null;
}

/**
 * Render the receiver of a `defineProperty` / `defineGetter` call as the
 * text used in the emitted symbolId, with `this` resolution.
 *
 * For non-`this` receivers (plain identifier, `exports.proto` chain) this
 * is identical to `receiverDisplayText` — verbatim text.
 *
 * For `this` we look upward to find an enclosing `function_expression` /
 * `function_declaration` that is the RHS of an outer assignment to a
 * receiver-rooted LHS (e.g. `app.init = function init() { … }`). When
 * found, the `this` token rebinds to that outer receiver — emit
 * `<outer-receiver>.<name>` instead of literal `this.<name>`. This catches
 * express's `app.init = function () { Object.defineProperty(this, 'router',
 * …); }` so we surface `app.router` rather than the misleading
 * `app.init.this.router` chain. bd tea-rags-mcp-d1f8 this-resolve.
 *
 * Free-floating `this` (top-level, no enclosing receiver-rooted assignment)
 * returns null — those references are unresolvable and emission is skipped
 * by the caller.
 */
function resolveReceiverText(receiver: Parser.SyntaxNode): string | null {
  if (receiver.type !== "this") return receiverDisplayText(receiver);
  const outer = resolveEnclosingThisReceiver(receiver);
  return outer; // null when no enclosing receiver — caller will skip.
}

/**
 * Walk `node.parent` upward looking for the outermost enclosing
 * function-valued expression that is the RHS of an outer
 * `<receiver>.<member> = function … { … }` assignment. Return the
 * receiver text (e.g. `"app"`, `"exports.proto"`) when found, else null.
 *
 * Arrow-function `this` would inherit from the enclosing lexical scope; we
 * still walk further out so nested arrow inside `app.init = function() {}`
 * still resolves to `app`. The chain stops at any non-callable parent.
 */
function resolveEnclosingThisReceiver(node: Parser.SyntaxNode): string | null {
  let cur: Parser.SyntaxNode | null = node.parent;
  while (cur) {
    if (
      cur.type === "function_expression" ||
      cur.type === "function_declaration" ||
      cur.type === "generator_function" ||
      cur.type === "generator_function_declaration"
    ) {
      // A non-arrow function rebinds `this` — we look at its assignment context.
      const fn = cur;
      const fnParent = fn.parent;
      if (fnParent?.type === "assignment_expression") {
        const right = fnParent.childForFieldName("right");
        // Confirm the function is on the RHS of the assignment.
        if (right === fn) {
          const left = fnParent.childForFieldName("left");
          if (left?.type === "member_expression") {
            const obj = left.childForFieldName("object");
            if (obj) {
              const text = receiverDisplayText(obj);
              if (text) return text;
            }
          }
        }
      }
      // Non-arrow function with no receiver-rooted assignment context.
      // `this` is unresolvable from here — stop walking (further outer
      // scopes won't bind this function's `this`).
      return null;
    }
    cur = cur.parent;
  }
  return null;
}

/**
 * Read the text of a string-literal arg.
 *
 * tree-sitter-javascript wraps strings as `string` with a `string_fragment`
 * child; template strings without interpolation parse as `template_string`.
 * Templates with interpolation are dynamic — skip them.
 */
function readStringLiteral(node: Parser.SyntaxNode): string | null {
  if (node.type === "string") {
    const frag = node.namedChildren.find((c) => c.type === "string_fragment");
    return frag ? frag.text : null;
  }
  if (node.type === "template_string") {
    // No-interpolation template — accept; with interpolation — reject.
    const hasInterp = node.namedChildren.some((c) => c.type === "template_substitution");
    if (hasInterp) return null;
    return node.text.replace(/^`|`$/g, "");
  }
  return null;
}

/**
 * Render the receiver expression as the text used in the emitted symbol.
 * Accepts plain identifiers (`app`, `req`), `this`, and member chains
 * (`exports.proto`). Returns null for shapes we can't render cleanly
 * (computed access, calls, etc.).
 */
function receiverDisplayText(node: Parser.SyntaxNode): string | null {
  if (node.type === "identifier") return node.text;
  if (node.type === "this") return "this";
  if (node.type === "member_expression") {
    // Static member chain like `exports.proto` — emit literal text.
    const obj = node.childForFieldName("object");
    const prop = node.childForFieldName("property");
    if (!obj || !prop) return null;
    if (prop.type !== "property_identifier") return null;
    const objText = receiverDisplayText(obj);
    if (!objText) return null;
    return `${objText}.${prop.text}`;
  }
  return null;
}

/**
 * Inspect an object literal for `get:` or `set:` pairs whose value is a
 * function. Used to filter `Object.defineProperty(obj, 'x', { value: 1 })`
 * (data descriptor — not a getter) from the getter form we care about.
 */
function objectHasGetterPair(node: Parser.SyntaxNode): boolean {
  for (const pair of node.namedChildren) {
    if (pair.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const value = pair.childForFieldName("value");
    if (!key || !value) continue;
    const keyText =
      key.type === "property_identifier" || key.type === "string" ? (readStringLiteral(key) ?? key.text) : null;
    if (keyText !== "get" && keyText !== "set") continue;
    if (isFunctionValuedExpression(value)) return true;
  }
  return false;
}

/**
 * Detect a pre-ES6 constructor function (bd tea-rags-mcp-mk45).
 *
 * Returns true when the file containing `node` (a `function_declaration`)
 * has at least one sibling assignment of the form
 * `<name>.prototype.<method> = <function-valued expr>` where `<name>` is
 * the function's identifier. The prototype-assignment sibling is the
 * canonical signal — uppercase-naming alone is too weak (many factory
 * functions follow PascalCase).
 *
 * Memoised per tree-rootNode via WeakMap so the cost is O(n) per file
 * instead of O(n^2) over `collectSymbols`' walk.
 */
function isJsConstructorFunction(node: Parser.SyntaxNode): boolean {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return false;
  const fnName = nameNode.text;
  const root = findRoot(node);
  if (!root) return false;
  const set = constructorFunctionNamesForRoot(root);
  return set.has(fnName);
}

const constructorNamesCache = new WeakMap<Parser.SyntaxNode, Set<string>>();

function constructorFunctionNamesForRoot(root: Parser.SyntaxNode): Set<string> {
  const cached = constructorNamesCache.get(root);
  if (cached) return cached;
  const names = new Set<string>();
  const visit = (n: Parser.SyntaxNode): void => {
    // Look for `Foo.prototype.X = <function>` at the assignment_expression
    // level. The walker already understands this shape in
    // `lhsToNamedSymbol` (pattern #2); here we only need the receiver name.
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left");
      const right = n.childForFieldName("right");
      const terminalRhs = right ? walkAssignmentChainToTerminalRhs(right) : null;
      if (left?.type === "member_expression" && terminalRhs && isFunctionValuedExpression(terminalRhs)) {
        const outerObj = left.childForFieldName("object");
        const outerProp = left.childForFieldName("property");
        // Match `<obj>.prototype.<method>` — outer object is itself a
        // member_expression whose property is the literal `prototype`.
        if (outerObj?.type === "member_expression" && outerProp?.type === "property_identifier") {
          const innerObj = outerObj.childForFieldName("object");
          const innerProp = outerObj.childForFieldName("property");
          if (
            innerObj?.type === "identifier" &&
            innerProp?.type === "property_identifier" &&
            innerProp.text === "prototype"
          ) {
            names.add(innerObj.text);
          }
        }
      }
    }
    for (const child of n.children) visit(child);
  };
  visit(root);
  constructorNamesCache.set(root, names);
  return names;
}

function findRoot(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.parent) cur = cur.parent;
  return cur;
}

/**
 * Walk an assignment_expression's `right` chain (`a = b = c = fn`) and
 * return the innermost non-assignment value. Caller checks whether the
 * terminal is function-valued.
 */
function walkAssignmentChainToTerminalRhs(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  let cur: Parser.SyntaxNode | null = node;
  while (cur?.type === "assignment_expression") {
    const right = cur.childForFieldName("right");
    if (!right) return null;
    cur = right;
  }
  return cur;
}

/**
 * `expr` is the value being assigned — accept any expression form that
 * carries a callable: named/anonymous function_expression, arrow_function.
 * Bound expressions (`fn.bind(this)`) and class_expression are out of
 * scope for this slice — they're rarer and would need receiver typing
 * to be useful in the symbol table.
 */
function isFunctionValuedExpression(node: Parser.SyntaxNode): boolean {
  return node.type === "function_expression" || node.type === "arrow_function" || node.type === "generator_function";
}

/**
 * Collect symbols for every LHS in an assignment chain. For
 * `res.contentType = res.type = fn` we recurse: the outer LHS is
 * `res.contentType`, the inner assignment's LHS is `res.type` — both
 * emit. Pushes into `out` in source order.
 *
 * Pattern #4 anonymous skip: `module.exports = function () {}` (no
 * explicit name) produces no symbol — `module.exports` is not a useful
 * top-level identifier. Caller decides which "function name" form to
 * adopt; we emit the inner function's name if present, else nothing.
 */
function collectAssignmentTargets(node: Parser.SyntaxNode, terminalRhs: Parser.SyntaxNode, out: NamedSymbol[]): void {
  if (node.type !== "assignment_expression") return;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (!left) return;
  const lhsSymbol = lhsToNamedSymbol(left, terminalRhs);
  if (lhsSymbol) out.push(lhsSymbol);
  if (right?.type === "assignment_expression") {
    collectAssignmentTargets(right, terminalRhs, out);
  }
}

/**
 * Convert a single LHS node into a `NamedSymbol` per the symbolId
 * convention rules. `terminalRhs` is the function value at the end of
 * the assignment chain — used to pull the function's own name for the
 * `module.exports = function name() {}` case.
 *
 * Returns null when the LHS is not a recognised top-level target:
 *  - computed property access (`obj[key] = fn`) — out of scope (bead k05k)
 *  - deep chains beyond `prototype` (`A.B.prototype.C` is not idiomatic)
 *  - anonymous `module.exports = function () {}` (no name to attach)
 */
function lhsToNamedSymbol(left: Parser.SyntaxNode, terminalRhs: Parser.SyntaxNode): NamedSymbol | null {
  // Bare identifier on the left is just reassignment of an existing
  // binding; the original declarator (variable_declarator) already
  // emitted the symbol. Skip to avoid duplicates.
  if (left.type === "identifier") return null;
  if (left.type !== "member_expression") return null;

  const obj = left.childForFieldName("object");
  const prop = left.childForFieldName("property");
  if (!obj || !prop) return null;
  if (prop.type !== "property_identifier") return null; // skip `obj[expr] = fn`
  const propText = prop.text;

  // Pattern #2: `Foo.prototype.bar = fn` — obj is itself a
  // member_expression whose property is `prototype`. Emit `Foo#bar`.
  if (obj.type === "member_expression") {
    const innerObj = obj.childForFieldName("object");
    const innerProp = obj.childForFieldName("property");
    if (innerObj && innerProp?.type === "property_identifier" && innerProp.text === "prototype") {
      // `Foo.prototype.bar` — Foo is the class. Use `#` directly in the
      // name since `collectSymbols` is at top-level scope when it sees
      // this assignment (composed === "") and joinSymbol just takes the
      // name verbatim. Embedding the `#` keeps the symbolId convention
      // consistent without requiring methodKind plumbing.
      const className = innerObj.text;
      return { name: `${className}${INSTANCE_METHOD_SEPARATOR}${propText}`, descendsInto: false };
    }
    // Deeper member chains (`a.b.c = fn`) are not idiomatic CommonJS
    // exports — skip to avoid polluting the symbol table.
    return null;
  }

  if (obj.type !== "identifier") return null;
  const objText = obj.text;

  // Pattern #3: `exports.foo = fn` → top-level `foo`.
  if (objText === "exports") {
    return { name: propText, descendsInto: false };
  }

  // Pattern #4: `module.exports = function name() {}` → top-level `name`.
  // The LHS is `module.exports`; we read the terminal function's name
  // (anonymous functions produce null, which the caller filters out).
  if (objText === "module" && propText === "exports") {
    const fnNameNode = terminalRhs.childForFieldName("name");
    if (!fnNameNode || fnNameNode.text.length === 0) return null;
    return { name: fnNameNode.text, descendsInto: false };
  }

  // Pattern #1: `obj.method = fn` → top-level `obj.method`. Receiver +
  // member rendered with `.` per symbolid-convention.md (module-method
  // shorthand on a non-class object).
  return { name: `${objText}.${propText}`, descendsInto: false };
}

function pyNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "class_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}

function rbNameOf(node: Parser.SyntaxNode): NamedSymbol | NamedSymbol[] | null {
  // Both `method` and `singleton_method` route through classifyMethod
  // (in core/infra/symbolid) so the chunker and codegraph agree on the
  // separator for the same physical AST node. classifyMethod also walks
  // up to detect `class << self` blocks — regular `method` nodes inside
  // a singleton_class become class-level and join with `.` instead of `#`.
  if (node.type === "method" || node.type === "singleton_method") {
    const id = node.childForFieldName("name");
    if (id) {
      const kind = methodKindFromClassify(node) ?? "instance";
      // bd tea-rags-mcp-08v2 — `extend self` in a module body promotes every
      // instance method to ALSO be callable as a module-level method (`M.foo`
      // alongside `M#foo`). The chunker still emits a single symbolId per def
      // (instance form, matching the AST node's primary kind); the codegraph
      // adds the class-form alias so callers reaching `M.foo` resolve.
      // Only fires for regular `method` nodes inside a `module` body — class
      // <<<self and def self.foo already produce static-form symbols via
      // classifyMethod, and `extend self` is conventionally a module idiom
      // (`extend self` inside a class is rare and semantically different).
      if (node.type === "method" && kind === "instance" && rubyMethodInsideExtendSelfModule(node)) {
        return [
          { name: id.text, descendsInto: false, methodKind: "instance" },
          { name: id.text, descendsInto: false, methodKind: "static" },
        ];
      }
      return { name: id.text, descendsInto: false, methodKind: kind };
    }
  }
  if (node.type === "class" || node.type === "module") {
    // `class Acme::Auth` — read the scope_resolution chain so the
    // qualified class name composes correctly with the outer scope.
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const localName = nameNode.type === "scope_resolution" ? scopeResolutionText(nameNode) : nameNode.text;
    return { name: localName, descendsInto: true };
  }
  // Ruby DSL macros — `attr_accessor :a, :b`, `has_many :products`, etc.
  // Each macro emits multiple synthetic methods at the current scope.
  // Only fires when the macro looks like a class-body declaration: a
  // `call` (or `method_call`) node with no receiver and a recognised
  // method name. Argument shape: a sequence of `simple_symbol` nodes.
  if (node.type === "call" || node.type === "method_call") {
    const defineMethodEmit = rubyDefineMethodEmission(node);
    if (defineMethodEmit) return defineMethodEmit;
    const aliasMethodEmit = rubyAliasMethodEmission(node);
    if (aliasMethodEmit) return aliasMethodEmit;
    const macro = rubyMacroEmission(node);
    if (macro) return macro;
  }
  // `alias new_name old_name` — Ruby keyword form is a distinct AST node
  // type (`alias`), not a `call`. Emit the new method name as an
  // instance method on the enclosing class so chunker and codegraph agree.
  if (node.type === "alias") {
    const aliasEmit = rubyAliasKeywordEmission(node);
    if (aliasEmit) return aliasEmit;
  }
  return null;
}

/**
 * `alias_method :new_name, :old_name` — declares `new_name` as an alias
 * for `old_name` on the enclosing class. Only the new name is emitted as
 * a synthetic instance method; the call from the alias to its target
 * lives in the call graph via the walker's synthetic CallRef
 * (bd tea-rags-mcp-y2z5).
 */
function rubyAliasMethodEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (methodNode?.text !== "alias_method") return null;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (firstArg?.type !== "simple_symbol") return null;
  const name = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  if (name.length === 0) return null;
  return { name, descendsInto: false, methodKind: "instance" };
}

/**
 * `alias new_name old_name` (keyword form) — separate AST node type
 * `alias` whose first identifier child is the new method name.
 */
function rubyAliasKeywordEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  const idents = node.children.filter((c) => c.type === "identifier");
  const newName = idents[0]?.text;
  if (!newName) return null;
  return { name: newName, descendsInto: false, methodKind: "instance" };
}

/**
 * `define_method(:foo) { ... }` — declares an instance method at
 * runtime. When the first argument is a literal symbol or string, the
 * method name is statically known and we treat the call as a regular
 * method declaration on the enclosing class scope. Dynamic args
 * (`define_method(verb) { ... }` where verb is a variable) remain
 * unrepresentable.
 */
function rubyDefineMethodEmission(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (methodNode?.text !== "define_method") return null;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const firstArg = args.namedChildren[0];
  if (!firstArg) return null;
  let name: string | null = null;
  if (firstArg.type === "simple_symbol") {
    name = firstArg.text.startsWith(":") ? firstArg.text.slice(1) : firstArg.text;
  } else if (firstArg.type === "string" || firstArg.type === "string_literal") {
    const inner = firstArg.namedChildren.find((c) => c.type === "string_content");
    name = inner ? inner.text : firstArg.text.replace(/^["']|["']$/g, "");
  }
  if (!name || name.length === 0) return null;
  return { name, descendsInto: false, methodKind: "instance" };
}

/**
 * Names of methods Ruby DSL macros emit at the enclosing class scope.
 * Each entry maps a macro name to a builder that takes a base name
 * (the symbol-argument text, with leading `:` stripped) and returns
 * the list of synthetic method names + their methodKind.
 *
 * Coverage:
 *   - attr_accessor / attr_reader / attr_writer — Ruby builtin
 *   - has_many / has_one / has_and_belongs_to_many / belongs_to — AR associations
 *   - scope — ActiveRecord class-level query helper (rare static case)
 *   - delegate — Forwardable / ActiveSupport delegation (instance forwarders)
 *
 * Out of scope (intentional):
 *   - method_missing — pure runtime dispatch, unrepresentable
 *   - dynamically constructed names: `define_method("foo_#{x}")` etc.
 *   - included do blocks (ActiveSupport::Concern) — needs mixin merge
 *     pass (bd: see Concern follow-up)
 */
const RUBY_DSL_MACROS: Record<string, (base: string) => { name: string; kind: "instance" | "static" }[]> = {
  attr_accessor: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  attr_reader: (b) => [{ name: b, kind: "instance" }],
  attr_writer: (b) => [{ name: `${b}=`, kind: "instance" }],
  has_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  has_one: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  // Legacy AR many-to-many — same accessor shape as has_many.
  has_and_belongs_to_many: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
  ],
  belongs_to: (b) => [
    { name: b, kind: "instance" },
    { name: `${b}=`, kind: "instance" },
    { name: `${b}_id`, kind: "instance" },
    { name: `${b}_id=`, kind: "instance" },
  ],
  // AR `scope :active, -> { ... }` — adds a class method named after the
  // first symbol argument. Only the first arg matters; the lambda is
  // body, not an accessor target.
  scope: (b) => [{ name: b, kind: "static" }],
  // `delegate :a, :b, to: :other` — emits forwarder methods on the
  // includer. We don't trace through `to:` (would need second-arg
  // type lookup); a forwarder being indexed in cg_symbols is enough
  // so a caller writing `obj.a` finds SOMETHING on `obj`'s class.
  delegate: (b) => [{ name: b, kind: "instance" }],
};

function rubyMacroEmission(node: Parser.SyntaxNode): NamedSymbol[] | null {
  // Macro calls in class body have no receiver field — they're direct
  // method invocations like `attr_accessor :x` rather than `obj.attr_accessor`.
  if (node.childForFieldName("receiver")) return null;
  const methodField = node.childForFieldName("method");
  // For tree-sitter-ruby `call` nodes the function position may also
  // appear as the first identifier child when no `method` field is
  // populated (parser-version variance — fall back tolerantly).
  const methodNode = methodField ?? node.children.find((c) => c.type === "identifier");
  if (!methodNode) return null;
  const macroName = methodNode.text;
  const builder = RUBY_DSL_MACROS[macroName];
  if (!builder) return null;
  // Argument list — `argument_list` field or the `arguments` field on
  // newer grammars.
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return null;
  const symbolBases: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    // `:product_ids` → strip leading `:`.
    const base = arg.text.startsWith(":") ? arg.text.slice(1) : arg.text;
    if (base.length > 0) symbolBases.push(base);
  }
  if (symbolBases.length === 0) return null;
  // For `scope :active, -> { ... }` only the first argument is the name;
  // for accessor macros every symbol argument generates its own method
  // set. Picking the first argument for `scope` is enforced by the
  // builder consuming `b` once.
  if (macroName === "scope") {
    const first = symbolBases[0];
    return builder(first).map((m) => ({ name: m.name, descendsInto: false, methodKind: m.kind }));
  }
  const out: NamedSymbol[] = [];
  for (const base of symbolBases) {
    for (const m of builder(base)) out.push({ name: m.name, descendsInto: false, methodKind: m.kind });
  }
  return out;
}

function goNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "method_declaration") {
    // Go receiver-bound methods are instance methods. The receiver type
    // must be embedded in the emitted name as `Receiver#Method` —
    // otherwise methods with the same shortName from different receivers
    // (e.g. `(*Context).Query` and `(*Bind).Query`) collapse in the
    // global symbol table and fabricate false-positive cycles plus
    // mis-routed call edges. See .claude/rules/symbolid-convention.md.
    const id = node.childForFieldName("name");
    if (!id) return null;
    const receiverType = extractGoReceiverType(node);
    const composed = receiverType ? `${receiverType}#${id.text}` : id.text;
    return { name: composed, descendsInto: false, methodKind: "instance" };
  }
  if (node.type === "function_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "type_declaration") {
    // type Foo struct { ... } → emit Foo as a top-level symbol.
    const spec = node.children.find((c) => c.type === "type_spec");
    const id = spec?.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

/**
 * Extract the receiver type name from a Go `method_declaration` node,
 * stripping pointer (`*Receiver` → `Receiver`) and dropping any generic
 * type-parameter list. Returns null if the receiver cannot be parsed
 * (defensive — tree-sitter-go is error-tolerant).
 */
function extractGoReceiverType(method: Parser.SyntaxNode): string | null {
  const receiver = method.childForFieldName("receiver");
  if (!receiver) return null;
  const param = receiver.children.find((c) => c.type === "parameter_declaration");
  if (!param) return null;
  const typeNode = param.childForFieldName("type");
  if (!typeNode) return null;
  // `*Receiver` pointer types wrap the identifier.
  const ident =
    typeNode.type === "pointer_type" ? typeNode.children.find((c) => c.type === "type_identifier") : typeNode;
  if (!ident) return null;
  if (ident.type === "generic_type") {
    const base = ident.childForFieldName("type");
    return base?.text ?? null;
  }
  return ident.text;
}

function javaNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "method_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "constructor_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: "instance" };
  }
  return null;
}

function rustNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false, methodKind: methodKindFromClassify(node) };
  }
  if (node.type === "struct_item" || node.type === "enum_item" || node.type === "trait_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "mod_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "impl_item") {
    // bd tea-rags-mcp-2hbd — `impl Trait for Type` MUST attribute methods
    // to the implementing TYPE, never the trait. tree-sitter-rust names
    // the implementing type as the `type` field in BOTH shapes:
    //   `impl Foo { ... }`             → type=Foo
    //   `impl Trait for Foo { ... }`   → type=Foo, trait=Trait
    // The trait child is intentionally ignored here as a class scope —
    // tracking it as a separate symbol is a future-spec concern.
    const ty = node.childForFieldName("type");
    if (!ty) return null;
    // bd tea-rags-mcp-h82m — strip generic params + lifetimes so
    // `impl<'s> Worker<'s>` → scope name "Worker", not "Worker<'s>".
    // `generic_type` is the tree-sitter-rust node wrapping a base type
    // identifier with `<...>`; pull the inner `type` field. For bare
    // `type_identifier` (no generics) the text is already clean.
    const name = stripRustGenerics(ty);
    if (!name) return null;
    return { name, descendsInto: true };
  }
  if (node.type === "macro_definition") {
    // bd tea-rags-mcp-jyzb — `macro_rules! foo { ... }` declares a macro.
    // tree-sitter-rust shapes the node as `macro_definition` with a
    // `name` field carrying the identifier. Emitting a symbol here lets
    // find_symbol("foo") resolve the macro definition.
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

/**
 * Strip generic parameters and lifetimes from a Rust impl type node:
 *   `Worker<'s>`        → "Worker"
 *   `Container<T>`      → "Container"
 *   `Container<T: Clone>` → "Container"
 *   `Foo`               → "Foo"
 * Returns null for unrecognized shapes.
 */
function stripRustGenerics(typeNode: Parser.SyntaxNode): string | null {
  if (typeNode.type === "generic_type") {
    const base = typeNode.childForFieldName("type");
    if (base) return base.text;
    // Fallback for grammar drift: take the first type_identifier child.
    const ident = typeNode.children.find((c) => c.type === "type_identifier");
    return ident?.text ?? null;
  }
  // `type_identifier`, `scoped_type_identifier`, or any leaf — use raw
  // text but strip any trailing `<...>` defensively (covers grammars
  // that flatten generic_type into the parent).
  const raw = typeNode.text;
  const lt = raw.indexOf("<");
  return (lt === -1 ? raw : raw.slice(0, lt)).trim() || null;
}

function bashNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

/**
 * `extend self` in a Ruby `module` body promotes every instance method
 * defined in that module to ALSO be callable as a module-level method:
 * `module M; extend self; def foo; end; end` makes both `M.new.foo` AND
 * `M.foo` valid (when an instance can be obtained, which for a pure
 * module only matters through the static-form anyway). The codegraph
 * provider mirrors this by emitting both `M#foo` (instance) and
 * `M.foo` (static) symbols for each regular method node.
 *
 * Detection walks up from the method node until the FIRST enclosing
 * `class`/`module` ancestor. If it's a `module`, scan its direct body
 * statements for a top-level `extend self` call (no receiver, method
 * name = `extend`, first arg is the `self` keyword). Stops at the first
 * class/module ancestor — a nested method inside a class within a module
 * with `extend self` is NOT in scope (the inner class re-opens the
 * receiver, so `extend self` of the OUTER module doesn't promote the
 * INNER class's instance methods).
 *
 * Returns false when the immediate container is a `class` (the idiom is
 * module-only by convention; class-level `extend self` is rare and the
 * semantics differ — instance methods don't become class methods on the
 * class itself, only on a singleton class of the class object, which
 * the existing `singleton_class` detection in `classifyMethod` covers).
 */
function rubyMethodInsideExtendSelfModule(methodNode: Parser.SyntaxNode): boolean {
  let p: Parser.SyntaxNode | null = methodNode.parent;
  while (p) {
    if (p.type === "class") return false;
    if (p.type === "module") {
      const body = p.childForFieldName("body");
      const stmts = body ? body.children : p.children;
      for (const stmt of stmts) {
        if (stmt.type !== "call" && stmt.type !== "method_call") continue;
        if (stmt.childForFieldName("receiver")) continue;
        const methodField = stmt.childForFieldName("method") ?? stmt.children.find((c) => c.type === "identifier");
        if (methodField?.text !== "extend") continue;
        const args = stmt.childForFieldName("arguments") ?? stmt.children.find((c) => c.type === "argument_list");
        if (!args) continue;
        const firstArg = args.namedChildren[0];
        if (firstArg?.type === "self") return true;
      }
      return false;
    }
    p = p.parent;
  }
  return false;
}

function scopeResolutionText(node: Parser.SyntaxNode): string {
  // Mirror ruby-walker's readScopeResolution; kept local to avoid an
  // export from the walker just for the provider's nameOf.
  const name = node.childForFieldName("name");
  const scope = node.childForFieldName("scope");
  if (!name) return "";
  const left =
    scope?.type === "scope_resolution" ? scopeResolutionText(scope) : scope?.type === "constant" ? scope.text : "";
  return left ? `${left}::${name.text}` : name.text;
}

/**
 * Slice 2 helper — drain `graphDb.streamAdjacency(scope)` into the
 * compact `Map<string, string[]>` shape that `tarjanScc` and
 * `pageRank` consume. Differs from the legacy `listAdjacency` only in
 * that the adapter no longer pre-bucketed the rows; we build the Map
 * exactly once here.
 */
async function collectAdjacency(graphDb: GraphDbClient, scope: "file" | "method"): Promise<Map<string, string[]>> {
  const adj = new Map<string, string[]>();
  for await (const [source, target] of graphDb.streamAdjacency(scope)) {
    const list = adj.get(source);
    if (list) list.push(target);
    else adj.set(source, [target]);
  }
  return adj;
}
