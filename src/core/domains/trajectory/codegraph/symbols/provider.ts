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

import { readdirSync, readFileSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";

import Parser from "tree-sitter";
import BashLang from "tree-sitter-bash";
import GoLang from "tree-sitter-go";
import JavaLang from "tree-sitter-java";
import JsLang from "tree-sitter-javascript";
import PyLang from "tree-sitter-python";
import RbLang from "tree-sitter-ruby";
import RustLang from "tree-sitter-rust";
import TsLang from "tree-sitter-typescript";

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
  EnrichmentProvider,
  FileSignalOverlay,
  FilterDescriptor,
  ProviderRunMetrics,
} from "../../../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../../../contracts/types/reranker.js";
import { extractFromBashFile } from "../../../ingest/pipeline/chunker/extraction/bash-walker.js";
import { extractFromGoFile } from "../../../ingest/pipeline/chunker/extraction/go-walker.js";
import { extractFromJavaFile } from "../../../ingest/pipeline/chunker/extraction/java-walker.js";
import { extractFromJavascriptFile } from "../../../ingest/pipeline/chunker/extraction/javascript-walker.js";
import { extractFromPythonFile } from "../../../ingest/pipeline/chunker/extraction/python-walker.js";
import { extractFromRubyFile } from "../../../ingest/pipeline/chunker/extraction/ruby-walker.js";
import { extractFromRustFile } from "../../../ingest/pipeline/chunker/extraction/rust-walker.js";
import { extractFromTypescriptFile } from "../../../ingest/pipeline/chunker/extraction/typescript-walker.js";
import { pageRank } from "../infra/page-rank.js";
import { tarjanScc } from "../infra/tarjan-scc.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";

const IGNORE_DIRS = new Set(["node_modules", "build", "dist", ".git", ".claude", "coverage", "tests", "test"]);

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
   * Maps a tree-sitter node to a (name, descendsInto) pair. Returns
   * null for nodes that are not top-level symbols. `descendsInto: true`
   * means the walker recurses into the node's children with extended
   * scope (e.g. class bodies whose methods become nested symbols).
   */
  nameOf: (node: Parser.SyntaxNode) => { name: string; descendsInto: boolean } | null;
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

export interface CodegraphProviderDeps {
  graphDb: GraphDbClient;
  symbolTable: GlobalSymbolTable;
  resolvers: Map<string, CallResolver>;
  /** Derived signals + presets are wired by `createSymbolsTrajectory` in T9. */
  derivedSignals?: DerivedSignalDescriptor[];
  presets?: RerankPreset[];
}

export class CodegraphEnrichmentProvider implements EnrichmentProvider {
  readonly key = "codegraph.symbols";
  readonly signals = [...CODEGRAPH_SYMBOLS_FILE_SIGNALS, ...CODEGRAPH_SYMBOLS_CHUNK_SIGNALS];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[] = [];
  readonly presets: RerankPreset[];

  private readonly buffer: FileExtraction[] = [];
  /**
   * (relPath -> startLine -> symbolId) — populated by the walker pass
   * in buildFileSignals so buildChunkSignals can resolve symbolId for
   * each ChunkLookupEntry by line number. ChunkLookupEntry only
   * carries `{chunkId, startLine, endLine}` — symbolId is not part of
   * the public contract.
   */
  private readonly chunkSymbolByLine = new Map<string, Map<number, string>>();
  /**
   * Per-run counters surfaced via `getRunMetrics()`. Read-and-cleared by
   * `CompletionRunner` at end of each enrichment cycle. Tracked here
   * (not in the sink) so they survive across multiple sink.write/finish
   * pairs within a single run (e.g. backfill paths).
   */
  private runStats = createEmptyRunStats();

  constructor(private readonly deps: CodegraphProviderDeps) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
  }

  resolveRoot(absolutePath: string): string {
    return absolutePath;
  }

  /**
   * Drop codegraph state for files that no longer exist on disk. Called
   * by `EnrichmentCoordinator.notifyDeletions` before sync prunes the
   * corresponding Qdrant points — keeps `cg_symbols_edges_*` consistent
   * with the file set. Idempotent: removing a path the provider never
   * saw is a no-op (graphDb.removeFile + symbolTable.removeFile both
   * tolerate unknown paths).
   */
  async handleDeletedPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const relPath of paths) {
      // `graphDb.removeFile` clears edges AND cg_symbols rows; the
      // separate `removeSymbolsForFile` is intentionally idempotent so
      // call sites that only want symbol-table cleanup (no edge
      // pruning) can use it independently. Calling both here is safe —
      // the second DELETE finds an empty set.
      await this.deps.graphDb.removeFile(relPath);
      await this.deps.graphDb.removeSymbolsForFile(relPath);
      this.deps.symbolTable.removeFile(relPath);
      this.chunkSymbolByLine.delete(relPath);
    }
  }

  asExtractionSink(): ExtractionSink {
    return {
      write: async (extraction) => {
        this.deps.symbolTable.upsertFile(
          extraction.relPath,
          extraction.chunks.map((c) => ({
            symbolId: c.symbolId,
            fqName: c.symbolId,
            shortName: lastSegment(c.symbolId),
            relPath: extraction.relPath,
            scope: c.scope,
          })),
        );
        // Index by line so buildChunkSignals can recover symbolId from
        // a ChunkLookupEntry that only carries chunkId+startLine+endLine.
        this.indexChunkSymbolsByLine(extraction);
        this.buffer.push(extraction);
        this.runStats.extractedFiles += 1;
      },
      finish: async () => {
        for (const extraction of this.buffer) {
          const edges = this.resolveExtraction(extraction);
          await this.deps.graphDb.upsertFile({ relPath: extraction.relPath, language: extraction.language }, edges);
          this.runStats.fileEdgeCount += edges.fileEdges.length;
          this.runStats.methodEdgeCount += edges.methodEdges.length;
          // Persist symbol definitions so the next cold-start bootstrap
          // can hydrate the in-memory table from disk. Partial reindex
          // (file A modified, file B untouched) can then resolve calls
          // from A into B because B's symbols are loaded at startup.
          const symbolDefs = extraction.chunks.map((c) => ({
            symbolId: c.symbolId,
            fqName: c.symbolId,
            shortName: lastSegment(c.symbolId),
            relPath: extraction.relPath,
            scope: c.scope,
          }));
          await this.deps.graphDb.upsertSymbols(extraction.relPath, symbolDefs);
        }
        this.buffer.length = 0;
        // Slice 2 / B2 + B3 — recompute Tarjan SCC for both scopes and
        // PageRank over the method graph after the full extraction
        // batch settles. Debounced by being on sink.finish (not
        // per-write) so a 700-file run pays the cost once.
        //
        // Algorithm ownership: adapter exposes pure CRUD primitives
        // (`listAdjacency`, `replaceCycles`, `replacePageRanks`); the
        // domain (this provider) runs Tarjan / PageRank from
        // `codegraph/infra/` and persists results. Keeps adapter
        // layer free of domain-level algorithm dependencies.
        //
        // Errors are non-fatal — losing cycle/PageRank freshness
        // degrades find_cycles / rerank but doesn't corrupt the
        // graph; the next sink.finish retries.
        try {
          const fileAdj = await this.deps.graphDb.listAdjacency("file");
          const fileSccs = tarjanScc(fileAdj);
          await this.deps.graphDb.replaceCycles("file", fileSccs);

          const methodAdj = await this.deps.graphDb.listAdjacency("method");
          const methodSccs = tarjanScc(methodAdj);
          await this.deps.graphDb.replaceCycles("method", methodSccs);

          const rankResult = pageRank(methodAdj);
          await this.deps.graphDb.replacePageRanks(rankResult.ranks);
        } catch (err) {
          if (process.env.DEBUG === "true") {
            process.stderr.write(`[codegraph] post-extract metric recompute failed: ${(err as Error).message}\n`);
          }
        }
      },
    };
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
      return undefined;
    }
    const resolveSuccessRate = callsAttempted === 0 ? 0 : callsResolved / callsAttempted;
    this.runStats = createEmptyRunStats();
    return { extractedFiles, fileEdgeCount, methodEdgeCount, resolveSuccessRate };
  }

  private indexChunkSymbolsByLine(extraction: FileExtraction): void {
    // The walker emits each chunk with line ranges driven by the AST
    // node it came from — but the ingest chunker may split that range
    // across multiple Qdrant chunks for oversize methods. We index the
    // span [startLine..endLine] -> symbolId so lookup by any line
    // inside the chunk resolves to the right symbol.
    let lineMap = this.chunkSymbolByLine.get(extraction.relPath);
    if (!lineMap) {
      lineMap = new Map();
      this.chunkSymbolByLine.set(extraction.relPath, lineMap);
    } else {
      lineMap.clear();
    }
    for (const c of extraction.chunks) {
      if (c.startLine !== undefined) lineMap.set(c.startLine, c.symbolId);
    }
  }

  private resolveChunkSymbolId(relPath: string, startLine: number, endLine: number): string | undefined {
    const lineMap = this.chunkSymbolByLine.get(relPath);
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

  async buildFileSignals(root: string, options?: { paths?: string[] }): Promise<Map<string, FileSignalOverlay>> {
    // Discover the file set to walk. Caller-supplied paths win
    // (incremental reindex); otherwise scan the repo for any
    // supported language extension.
    const targetRelPaths =
      options?.paths && options.paths.length > 0
        ? options.paths.filter((p) => SUPPORTED_EXTS.has(extensionOf(p)))
        : this.discoverSupportedFiles(root);

    // Populate the graph DB by walking each file's AST and feeding the
    // resulting FileExtraction through this provider's own sink. This
    // pass owns the codegraph ingest side — chunker pool integration
    // is deferred to a future slice once worker IPC supports passing
    // FileExtraction back across the boundary.
    const sink = this.asExtractionSink();
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
      const fanIn = await this.deps.graphDb.getFanIn(relPath);
      const fanOut = await this.deps.graphDb.getFanOut(relPath);
      const denom = fanIn + fanOut;
      // Slice 2 / B1 — transitive blast radius via reverse BFS over
      // file edges. Depth defaults to 5 (in DuckDB client). Cheap on
      // small files (early-empty); on hub files the DuckDB recursive
      // CTE handles up to ~thousands of ancestors comfortably.
      const transitiveImpact = await this.deps.graphDb.getTransitiveImpact(relPath);
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
   * Recursively enumerate `.ts` / `.tsx` files under `root`, skipping
   * `node_modules`, `build`, etc. Returns repo-relative POSIX paths.
   * Slice 1 owns this walker; later slices will share the file-discovery
   * pass already done by `processFiles` once the chunker pool returns
   * AST artifacts alongside chunks.
   */
  private discoverSupportedFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".claude-plugin") continue;
        if (IGNORE_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.isFile() && SUPPORTED_EXTS.has(extensionOf(entry.name))) {
          out.push(relative(root, full).replace(/\\/g, "/"));
        }
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
    nameOf: (node: Parser.SyntaxNode) => { name: string; descendsInto: boolean } | null,
    separator: string,
  ): { symbolId: string; startLine: number; endLine: number; scope: string[] }[] {
    const out: { symbolId: string; startLine: number; endLine: number; scope: string[] }[] = [];
    const walk = (node: Parser.SyntaxNode, scope: string[]): void => {
      const named = nameOf(node);
      if (named) {
        const fq = [...scope, named.name].join(separator);
        out.push({
          symbolId: fq,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          scope,
        });
        if (named.descendsInto) {
          for (const child of node.children) walk(child, [...scope, named.name]);
          return;
        }
      }
      for (const child of node.children) walk(child, scope);
    };
    walk(tree.rootNode, []);
    return out;
  }

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    _options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const [relPath, entries] of chunkMap) {
      const perChunk = new Map<string, ChunkSignalOverlay>();
      for (const entry of entries) {
        // ChunkLookupEntry only carries chunkId + startLine/endLine;
        // resolveChunkSymbolId pulls symbolId from the walker-indexed
        // line map (populated when the same provider walked the file
        // in buildFileSignals). If file isn't in the map (e.g. older
        // chunks from before codegraph wiring, or non-TS files), skip.
        const symbolId = this.resolveChunkSymbolId(relPath, entry.startLine, entry.endLine);
        if (!symbolId) continue;
        const fanIn = await this.deps.graphDb.getCalledByCount(symbolId);
        const fanOut = await this.deps.graphDb.getCallSiteCount(symbolId);
        // Slice 2 / B3 — per-symbol PageRank from cg_symbols_metrics
        // (populated by recomputePageRank at sink.finish). Returns 0
        // when the symbol isn't in the table yet (first index pass
        // before recompute completes, or non-TS chunks without
        // extraction edges).
        const pageRankValue = await this.deps.graphDb.getPageRank(symbolId);
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

  private resolveExtraction(extraction: FileExtraction): GraphEdges {
    const resolver = this.deps.resolvers.get(extraction.language);
    const fileEdges: GraphEdges["fileEdges"] = [];
    const methodEdges: GraphEdges["methodEdges"] = [];
    if (!resolver) return { fileEdges, methodEdges };

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
          symbolTable: this.deps.symbolTable,
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
          symbolTable: this.deps.symbolTable,
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
  // Two callers with different separator conventions:
  //  - symbolIds like "Foo.bar" split on "." → "bar"
  //  - import paths like "../core/api/index.js" split on "/" → "index.js"
  // Path lookups must NOT split on "." or we'd return the extension
  // ("js") instead of the basename. Prefer "/" when present; only fall
  // back to "." for "/"-free symbolIds.
  const slash = name.lastIndexOf("/");
  if (slash !== -1) return name.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(dot + 1);
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot === -1 ? "" : path.slice(dot);
}

function tsNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  if (node.type === "function_declaration" || node.type === "method_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}

function pyNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  if (node.type === "function_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class_definition") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  return null;
}

function rbNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  // tree-sitter-ruby: `class A; end`, `module B; end`, `def foo; end`.
  // class/module name can itself be a scope_resolution (`class A::B`)
  // — read the full chain as the local name so the symbol id
  // composes correctly with the outer scope at join time.
  if (node.type === "method" || node.type === "singleton_method") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  if (node.type === "class" || node.type === "module") {
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return null;
    const localName = nameNode.type === "scope_resolution" ? scopeResolutionText(nameNode) : nameNode.text;
    return { name: localName, descendsInto: true };
  }
  return null;
}

function goNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  // Go has no nesting at the type level — methods declare on a
  // receiver but are top-level. function_declaration is plain
  // functions; method_declaration is methods (with field `name`).
  if (node.type === "function_declaration" || node.type === "method_declaration") {
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

function javaNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: true };
  }
  if (node.type === "method_declaration" || node.type === "constructor_declaration") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
  }
  return null;
}

function rustNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
  if (node.type === "function_item") {
    const id = node.childForFieldName("name");
    if (id) return { name: id.text, descendsInto: false };
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
    // tree-sitter-rust uses `type` field for the impl target.
    const ty = node.childForFieldName("type");
    if (ty) return { name: ty.text, descendsInto: true };
  }
  return null;
}

function bashNameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
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
