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
} from "../../../../contracts/types/provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "../../../../contracts/types/reranker.js";
import { extractFromTypescriptFile } from "../../../ingest/pipeline/chunker/extraction/typescript-walker.js";
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";

const IGNORE_DIRS = new Set(["node_modules", "build", "dist", ".git", ".claude", "coverage", "tests", "test"]);
const TS_EXTS = new Set([".ts", ".tsx"]);

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

  constructor(private readonly deps: CodegraphProviderDeps) {
    this.derivedSignals = deps.derivedSignals ?? [];
    this.presets = deps.presets ?? [];
  }

  resolveRoot(absolutePath: string): string {
    return absolutePath;
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
      },
      finish: async () => {
        for (const extraction of this.buffer) {
          const edges = this.resolveExtraction(extraction);
          await this.deps.graphDb.upsertFile({ relPath: extraction.relPath, language: extraction.language }, edges);
        }
        this.buffer.length = 0;
      },
    };
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
    // (incremental reindex); otherwise scan the repo for `.ts`/`.tsx`.
    const targetRelPaths =
      options?.paths && options.paths.length > 0
        ? options.paths.filter((p) => TS_EXTS.has(extensionOf(p)))
        : this.discoverTypescriptFiles(root);

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
      result.set(relPath, {
        "codegraph.file.fanIn": fanIn,
        "codegraph.file.fanOut": fanOut,
        "codegraph.file.instability": denom === 0 ? 0 : fanOut / denom,
        // isHub is finalised by the IsHubSignal derived signal against
        // the cohort p95 at rerank time. The payload field stays in
        // place with a stable default so reranker overlays don't churn.
        "codegraph.file.isHub": false,
        "codegraph.file.isLeaf": fanOut === 0 && fanIn > 0,
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
  private discoverTypescriptFiles(root: string): string[] {
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
        if (entry.isFile() && TS_EXTS.has(extensionOf(entry.name))) {
          out.push(relative(root, full).replace(/\\/g, "/"));
        }
      }
    };
    walk(root);
    return out;
  }

  /**
   * Parse a single TS file from disk and produce a `FileExtraction`
   * matching the chunker's symbol shape. The chunker proper applies
   * richer hooks (class-body, test-DSL, oversized split) — codegraph
   * needs only the top-level symbol identifiers, so a simple walker
   * over function/method/class declarations is sufficient for slice 1.
   */
  private extractOneFile(root: string, relPath: string): FileExtraction {
    const code = readFileSync(join(root, relPath), "utf8");
    const parser = new Parser();
    parser.setLanguage((TsLang as { typescript: Parser.Language; tsx: Parser.Language }).typescript);
    const tree = parser.parse(code);
    const chunks = this.collectSymbols(tree);
    return extractFromTypescriptFile({
      tree,
      code,
      relPath,
      language: "typescript",
      chunks,
    });
  }

  private collectSymbols(
    tree: Parser.Tree,
  ): { symbolId: string; startLine: number; endLine: number; scope: string[] }[] {
    const out: { symbolId: string; startLine: number; endLine: number; scope: string[] }[] = [];
    const walk = (node: Parser.SyntaxNode, scope: string[]): void => {
      const named = nameOf(node);
      if (named) {
        const fq = [...scope, named.name].join(".");
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
        perChunk.set(entry.chunkId, {
          "codegraph.chunk.fanIn": fanIn,
          "codegraph.chunk.fanOut": fanOut,
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

    // Method-level edges from calls.
    for (const chunk of extraction.chunks) {
      for (const call of chunk.calls) {
        const target = resolver.resolve(call, {
          callerFile: extraction.relPath,
          callerScope: chunk.scope,
          imports: extraction.imports,
          symbolTable: this.deps.symbolTable,
        });
        if (!target) continue;
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

function nameOf(node: Parser.SyntaxNode): { name: string; descendsInto: boolean } | null {
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
