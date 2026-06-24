import type {
  CycleScope,
  GraphEdges,
  GraphFileNode,
  RelPath,
  ResolveRunStatsRow,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";

/**
 * In daemon mode the `DaemonGraphDbClient` is the SOLE accessor of the DuckDB
 * file (the daemon owns the single RW connection), so it must proxy the ENTIRE
 * `GraphDbClient` surface the codegraph layer touches — every write AND every
 * read — over the socket. The only exception is `streamAdjacency`: the heavy
 * graph analysis runs daemon-side via `computeAndPersistCyclesAndSignals`, so
 * the adjacency stream stays daemon-internal and is never proxied over IPC.
 */
export type DaemonOp =
  | "handshake"
  | "finalizeReindex"
  // ── writes ──
  | "upsertFile"
  | "removeFile"
  | "removeSymbolsForFile"
  | "upsertSymbols"
  | "updateSymbolChunkIds"
  | "replaceCycles"
  | "replacePageRanks"
  | "checkpoint"
  | "recordRunStats"
  | "computeAndPersistCyclesAndSignals"
  // ── reads (the daemon owns the sole DuckDB connection, so all reads route
  //    through its own RW connection instead of a conflicting cross-process
  //    READ_ONLY attach) ──
  | "getFanIn"
  | "getFanInP95"
  | "getFanOut"
  | "getCallers"
  | "getCallees"
  | "getCalleeEdges"
  | "getCalledByCount"
  | "getCallSiteCount"
  | "hasData"
  | "getRunStats"
  | "getEdgeKindDistribution"
  | "listAllSymbols"
  | "getTransitiveImpact"
  | "findCycles"
  | "listAdjacency"
  | "getPageRank"
  | "findSymbolChunk"
  // ── class hierarchy (bd tea-rags-mcp-f10y) ──
  | "getSupertypes"
  | "getSubtypes"
  | "getTransitiveSubtypes"
  | "loadHierarchySnapshot";

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params:
    | { collection: string } // handshake | checkpoint | computeAndPersistCyclesAndSignals | hasData | getRunStats | listAllSymbols
    | { collection: string; node: GraphFileNode; edges: GraphEdges } // upsertFile
    | { collection: string; relPath: RelPath } // removeFile | removeSymbolsForFile | getFanIn | getFanOut
    | { collection: string; relPath: RelPath; definitions: SymbolDefinition[] } // upsertSymbols
    | { collection: string; relPath: RelPath; chunkIds: [string, string][] } // updateSymbolChunkIds
    | { collection: string; relPath: RelPath; maxDepth?: number } // getTransitiveImpact
    | { collection: string; oldVersion: string; newVersion: string } // finalizeReindex
    | { collection: string; symbolId: SymbolId } // getCallers | getCallees | getCalledByCount | getCallSiteCount | getPageRank
    | { collection: string; symbolIds: SymbolId[] } // getCalleeEdges
    | { collection: string; scope: CycleScope; pathPattern?: string } // findCycles (pathPattern) | listAdjacency
    | { collection: string; scope: CycleScope; sccs: readonly (readonly string[])[] } // replaceCycles
    | { collection: string; ranks: [string, number][] } // replacePageRanks
    | { collection: string; rows: ResolveRunStatsRow[] } // recordRunStats
    | { collection: string; fqName: string }; // getSupertypes | getSubtypes | getTransitiveSubtypes
}

export type DaemonResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { name: string; message: string } };

/** One JSON object per line. `\n` is the frame delimiter (JSON.stringify never emits a raw newline). */
export function encodeFrame(msg: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(msg)}\n`;
}

/** Split a buffer on newlines; return complete frames and the partial trailing `rest`. */
export function decodeFrames(buffer: string): { frames: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { frames: parts.filter((p) => p.length > 0), rest };
}
