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
import { classifyMethod } from "../../../../infra/symbolid/index.js";
import { extractFromBashFile } from "../../../ingest/pipeline/chunker/extraction/bash-walker.js";
import { extractFromJavaFile } from "../../../ingest/pipeline/chunker/extraction/java-walker.js";
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
   *
   * OPTIONAL: a language migrated to a native `domains/language/<lang>` provider
   * (ruby / typescript / javascript — tea-rags-mcp-cen6) drops its `nameOf` here
   * because the engine reads it from `factory.create(lang).walker.nameOf`. The
   * entry is retained only for `loadParser` / `scopeSeparator` /
   * `disambiguateOverloads`, which still source from this map. Dropped together
   * with `walker` (a `nameOf` without `walk` is meaningless). Non-migrated
   * languages keep both (the legacy adapter wraps them).
   */
  nameOf?: (node: Parser.SyntaxNode) => NamedSymbol | NamedSymbol[] | null;
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
    // walker + nameOf DROPPED — typescript migrated to the native
    // domains/language/typescript provider (tea-rags-mcp-cen6). The engine reads
    // `walk`/`nameOf` from `factory.create("typescript").walker`; this entry is
    // retained only for `loadParser` (the `.typescript` grammar) / `scopeSeparator`,
    // still sourced from the map so the per-extension grammar choice for `.ts` vs
    // `.tsx` stays here. `tsNameOf` now lives in the typescript vertical's
    // `walker/name-of.ts`; the JavaScript vertical sibling-imports it.
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).tsx,
    // walker + nameOf DROPPED — see the `.ts` entry. `loadParser` here selects the
    // `.tsx` grammar (the one difference between the two extensions); the native
    // provider's single walker handles both grammars' node types.
    scopeSeparator: ".",
  },
  ".py": {
    language: "python",
    loadParser: () => PyLang as Parser.Language,
    // walker + nameOf DROPPED — python migrated to the native domains/language/python
    // provider (tea-rags-mcp-cen6). The engine reads `walk`/`nameOf` from
    // `factory.create("python").walker`; this entry is retained only for
    // `loadParser` / `scopeSeparator` (still sourced from the map).
    scopeSeparator: ".",
  },
  ".rb": {
    language: "ruby",
    loadParser: () => RbLang as Parser.Language,
    // walker + nameOf DROPPED — ruby migrated to the native domains/language/ruby
    // provider (tea-rags-mcp-cen6). The engine reads `walk`/`nameOf` from
    // `factory.create("ruby").walker`; this entry is retained only for
    // `loadParser` / `scopeSeparator` (still sourced from the map).
    scopeSeparator: "::",
  },
  // JavaScript variants — migrated to the native domains/language/javascript
  // provider (tea-rags-mcp-cen6). walker + nameOf DROPPED here; the engine reads
  // `walk`/`nameOf` from `factory.create("javascript").walker`. These entries are
  // retained only for `loadParser` (the single `tree-sitter-javascript` grammar
  // serves all four extensions) / `scopeSeparator`. The native `jsNameOf`
  // sibling-imports `tsNameOf` from the typescript vertical and adds the CommonJS
  // / pre-class shapes (bd tea-rags-mcp-mwty / z95o / d1f8).
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
    // walker + nameOf DROPPED — go migrated to the native domains/language/go
    // provider (tea-rags-mcp-cen6). The engine reads `walk`/`nameOf` from
    // `factory.create("go").walker`; this entry is retained only for
    // `loadParser` / `scopeSeparator` (still sourced from the map).
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
 *
 * The TypeScript (`tsNameOf`), JavaScript (`jsNameOf` + its CommonJS helper web),
 * Ruby (`rbNameOf`), Python (`pyNameOf`) and Go (`goNameOf` + its
 * `extractGoReceiverType` helper) functions are GONE from here — those
 * languages migrated to native `domains/language/<lang>` providers
 * (tea-rags-mcp-cen6); the engine reads their `nameOf` from
 * `factory.create(lang).walker.nameOf`. Only the still-legacy-adapter languages
 * (java / rust / bash) keep a `<lang>NameOf` here. `methodKindFromClassify`
 * stays — `javaNameOf` / `rustNameOf` use it.
 */

function methodKindFromClassify(node: Parser.SyntaxNode): "instance" | "static" | undefined {
  const c = classifyMethod(node);
  return c === null ? undefined : c;
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
