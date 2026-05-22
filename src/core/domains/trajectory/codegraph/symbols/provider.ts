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
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
} from "../../../../contracts/types/codegraph.js";
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
import { extractFromRubyFile } from "../../../ingest/pipeline/chunker/extraction/ruby-walker.js";
import { extractFromRustFile } from "../../../ingest/pipeline/chunker/extraction/rust-walker.js";
import { extractFromTypescriptFile } from "../../../ingest/pipeline/chunker/extraction/typescript-walker.js";
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

interface NamedSymbol {
  name: string;
  descendsInto: boolean;
  /**
   * Distinguishes the universal class/method separator from the
   * language's namespace separator. `"instance"` uses `#`; `"static"`
   * uses `.`. Both override the language's `scopeSeparator` (which
   * applies to namespaces / nested classes / top-level chains).
   * Per `.claude/rules/symbolid-convention.md`.
   */
  methodKind?: "instance" | "static";
}

/**
 * Compose the next fully-qualified id by appending `child.name` to
 * `composed` with the correct separator:
 *   - Top-level (`composed === ""`) → just the name.
 *   - `methodKind: "instance"` → `composed#child.name` (any language).
 *   - `methodKind: "static"`   → `composed.child.name` (any language).
 *   - Otherwise → `composed{scopeSeparator}child.name` (language-local).
 */
function joinSymbol(composed: string, child: NamedSymbol, scopeSeparator: string): string {
  if (composed.length === 0) return child.name;
  const sep =
    child.methodKind === "instance" ? INSTANCE_METHOD_SEPARATOR : child.methodKind === "static" ? "." : scopeSeparator;
  return `${composed}${sep}${child.name}`;
}

/**
 * Per-language extraction dispatch table. Codegraph walks any file
 * whose extension appears here. The walker emits a FileExtraction; the
 * symbol collector pulls top-level symbols out of the parsed tree.
 *
 * Adding a language: add a tree-sitter parser to deps, create a walker
 * in ingest/pipeline/chunker/extraction/, drop a row here.
 */
interface LanguageConfig {
  language: string;
  loadParser: () => Parser.Language;
  walker: (input: {
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
}

const LANGUAGES: Record<string, LanguageConfig> = {
  ".ts": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).typescript,
    walker: extractFromTypescriptFile,
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".tsx": {
    language: "typescript",
    loadParser: () => (TsLang as { typescript: Parser.Language; tsx: Parser.Language }).tsx,
    walker: extractFromTypescriptFile,
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
    walker: extractFromRubyFile,
    nameOf: rbNameOf,
    scopeSeparator: "::",
  },
  // JavaScript variants share grammar node types — the JS walker
  // handles ES module imports, CommonJS require(), and dynamic
  // import() in one pass. tsNameOf works as-is because
  // function_declaration / method_definition / class_declaration
  // have the same shape in tree-sitter-javascript.
  ".js": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".jsx": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".mjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: tsNameOf,
    scopeSeparator: ".",
  },
  ".cjs": {
    language: "javascript",
    loadParser: () => JsLang as Parser.Language,
    walker: extractFromJavascriptFile,
    nameOf: tsNameOf,
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
const SUPPORTED_EXTS = new Set(Object.keys(LANGUAGES));

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
      return undefined;
    }
    const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / callsAttempted;
    this.runStats = createEmptyRunStats();
    this.runAncestors = {};
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
      result.set(relPath, {
        "codegraph.file.fanIn": fanIn,
        "codegraph.file.fanOut": fanOut,
        "codegraph.file.instability": denom === 0 ? 0 : fanOut / denom,
        // isHub is finalised by the IsHubSignal derived signal against
        // the cohort p95 at rerank time. The payload field stays in
        // place with a stable default so reranker overlays don't churn.
        "codegraph.file.isHub": false,
        "codegraph.file.isLeaf": fanOut === 0 && fanIn > 0,
        "codegraph.file.transitiveImpact": transitiveImpact,
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
    const langConfig = LANGUAGES[ext];
    if (!langConfig) {
      // discoverSupportedFiles already filters by SUPPORTED_EXTS; this
      // is a defensive guard for callers that pass paths directly.
      return { relPath, language: "", imports: [], chunks: [], fileScope: [] };
    }
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage(langConfig.loadParser());
    const tree = parser.parse(code);
    const chunks = this.collectSymbols(tree, langConfig.nameOf, langConfig.scopeSeparator);
    return langConfig.walker({
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
            symbolId: joinSymbol(composed, ns, separator),
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
      const childComposed = named ? joinSymbol(composed, named, separator) : composed;
      if (named) {
        out.push({
          symbolId: childComposed,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scope,
        });
      }
      for (const child of node.children) walk(child, childScope, childComposed);
    };
    walk(tree.rootNode, [], "");
    // Dedup by symbolId — multiple AST nodes can legitimately share an
    // identifier (TypeScript get/set accessor pairs, function overload
    // signatures, etc.). The cg_symbols PK (rel_path, symbol_id) treats
    // identity, not occurrences; the in-memory symbol table likewise
    // benefits from one entry per name (lookups otherwise produce
    // spurious ambiguity). Keep the FIRST occurrence — by line order
    // that's the earliest declaration site, which is the deterministic
    // anchor for downstream chunk-line bucketing.
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
        perChunk.set(entry.chunkId, {
          "codegraph.chunk.fanIn": fanIn,
          "codegraph.chunk.fanOut": fanOut,
          "codegraph.chunk.pageRank": pageRankValue,
        });
      }
      out.set(relPath, perChunk);
    }
    return out;
  }

  private resolveExtraction(extraction: FileExtraction, symbolTable: GlobalSymbolTable): GraphEdges {
    const resolver = this.deps.resolvers.get(extraction.language);
    const fileEdges: GraphEdges["fileEdges"] = [];
    const methodEdges: GraphEdges["methodEdges"] = [];
    if (!resolver) return { fileEdges, methodEdges };

    // Resolver receives the run-global `classAncestors` so it can walk
    // a bound type's inheritance chain regardless of which file
    // declares that class. Per-file ancestors are merged into
    // `this.runAncestors` during pass-1 (sink.write).
    const ancestorsForResolver =
      Object.keys(this.runAncestors).length > 0 ? this.runAncestors : extraction.classAncestors;
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
        const target = resolver.resolve(call, {
          callerFile: extraction.relPath,
          callerScope: chunk.scope,
          imports: extraction.imports,
          symbolTable,
          classFieldTypes: extraction.classFieldTypes,
          localBindings: chunk.localBindings,
          classAncestors: ancestorsForResolver,
        });
        if (!target) continue;
        this.runStats.callsResolved += 1;
        methodEdges.push({
          sourceSymbolId: chunk.symbolId,
          targetSymbolId: target.targetSymbolId,
          targetRelPath: target.targetRelPath,
          callExpression: call.callText,
        });
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
  // Three callers with different separator conventions:
  //  - symbolIds like "Foo#bar" (instance) split on "#" → "bar"
  //  - symbolIds like "Foo.bar" (static / nested namespace) split on "." → "bar"
  //  - import paths like "../core/api/index.js" split on "/" → "index.js"
  // Path lookups must NOT split on "." or we'd return the extension
  // ("js") instead of the basename. Order is: "/" wins (path detection),
  // then "#" (instance method short-name), then "." (static / namespace
  // last component).
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  const hash = name.lastIndexOf("#");
  if (hash !== -1) return name.slice(hash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
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
  if (node.type === "class_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
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
    const macro = rubyMacroEmission(node);
    if (macro) return macro;
  }
  return null;
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
    // impl Foo { ... } — surface Foo's methods under `impl Foo` scope.
    const ty = node.childForFieldName("type");
    if (ty) return { name: ty.text, descendsInto: true };
  }
  return null;
}

function bashNameOf(node: Parser.SyntaxNode): NamedSymbol | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
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
