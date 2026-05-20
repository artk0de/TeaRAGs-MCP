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
import { CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, CODEGRAPH_SYMBOLS_FILE_SIGNALS } from "./payload-signals.js";

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

  async buildFileSignals(_root: string, options?: { paths?: string[] }): Promise<Map<string, FileSignalOverlay>> {
    const paths = options?.paths ?? [];
    const result = new Map<string, FileSignalOverlay>();
    for (const relPath of paths) {
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

  async buildChunkSignals(
    _root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    _options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const [relPath, entries] of chunkMap) {
      const perChunk = new Map<string, ChunkSignalOverlay>();
      for (const entry of entries) {
        const e = entry as { symbolId?: string; id?: string; chunkId?: string };
        const { symbolId } = e;
        if (!symbolId) continue;
        const calledByCount = await this.deps.graphDb.getCalledByCount(symbolId);
        const callSiteCount = await this.deps.graphDb.getCallSiteCount(symbolId);
        const chunkKey = e.id ?? e.chunkId ?? symbolId;
        perChunk.set(chunkKey, {
          "codegraph.chunk.calledByCount": calledByCount,
          "codegraph.chunk.callSiteCount": callSiteCount,
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
  const idx = Math.max(name.lastIndexOf("."), name.lastIndexOf("/"));
  return idx === -1 ? name : name.slice(idx + 1);
}
