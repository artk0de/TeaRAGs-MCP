import type {
  CycleScope,
  GraphEdges,
  GraphFileNode,
  RelPath,
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
  | "replaceCycles"
  | "replacePageRanks"
  | "checkpoint"
  | "computeAndPersistCyclesAndSignals"
  // ── reads (the daemon owns the sole DuckDB connection, so all reads route
  //    through its own RW connection instead of a conflicting cross-process
  //    READ_ONLY attach) ──
  | "getFanIn"
  | "getFanOut"
  | "getCallers"
  | "getCallees"
  | "getCalledByCount"
  | "getCallSiteCount"
  | "hasData"
  | "listAllSymbols"
  | "getTransitiveImpact"
  | "findCycles"
  | "listAdjacency"
  | "getPageRank";

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params:
    | { collection: string } // handshake | checkpoint | computeAndPersistCyclesAndSignals | hasData | listAllSymbols
    | { collection: string; node: GraphFileNode; edges: GraphEdges } // upsertFile
    | { collection: string; relPath: RelPath } // removeFile | removeSymbolsForFile | getFanIn | getFanOut
    | { collection: string; relPath: RelPath; definitions: SymbolDefinition[] } // upsertSymbols
    | { collection: string; relPath: RelPath; maxDepth?: number } // getTransitiveImpact
    | { collection: string; oldVersion: string; newVersion: string } // finalizeReindex
    | { collection: string; symbolId: SymbolId } // getCallers | getCallees | getCalledByCount | getCallSiteCount | getPageRank
    | { collection: string; scope: CycleScope } // findCycles | listAdjacency
    | { collection: string; scope: CycleScope; sccs: readonly (readonly string[])[] } // replaceCycles
    | { collection: string; ranks: [string, number][] }; // replacePageRanks
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
