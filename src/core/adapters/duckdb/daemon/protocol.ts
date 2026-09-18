import type {
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CycleScope,
  FileResolveStatsWrite,
  FileScopedSymbolRef,
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
 *
 * `DAEMON_OPS` is the protocol's op list at runtime (bd tea-rags-mcp-39xca.4).
 * `DaemonOp` is derived from it and the daemon's dispatch table
 * (`DAEMON_OP_COMMANDS`) is keyed by `DaemonOp`, so an op cannot exist in one
 * without the other; the client derives its REQUIRED ops from the same list.
 */
export const DAEMON_OPS = [
  "handshake",
  // Graceful drain+exit requested by a client whose build fingerprint differs
  // from the daemon's (bd tea-rags-mcp-ji56r). Handled by the TRANSPORT layer
  // (daemon/entry.ts) — acked first, then the daemon reuses the idle-watcher
  // drain/exit path — so it never reaches the request dispatcher.
  "shutdown",
  // Liveness probe (bd tea-rags-mcp-f924y): a client with calls pending sends it
  // when the daemon has gone quiet. Any answer proves the daemon alive — even the
  // "unknown daemon op" of a daemon from before the op existed, which is why it
  // is a tolerated legacy op (`LEGACY_TOLERATED_OPS`).
  "ping",
  "finalizeReindex",
  // ── writes ──
  "upsertFile",
  "removeFile",
  "removeSymbolsForFile",
  "upsertSymbols",
  "upsertSymbolsBulk",
  "upsertFilesBulk",
  "updateSymbolChunkIds",
  "updateSymbolChunkIdsBulk",
  "replaceCycles",
  "replacePageRanks",
  "checkpoint",
  "rebuildEdgeFileTargetIndex",
  "recordRunStats",
  // Per-file resolve tallies + language coverage (bd tea-rags-mcp-xpmwg). Its
  // own op rather than a wider `recordRunStats` payload, so a daemon from an
  // older build never receives a params shape it predates.
  "recordFileResolveStats",
  "computeAndPersistCyclesAndSignals",
  // Baseline refresh for the derived-signal drift diff (bd tea-rags-mcp-a2ddb).
  // A WRITE: it replaces both `cg_*_signals_prev` tables in one transaction.
  "refreshSymbolSignalsPrev",
  // ── reads (the daemon owns the sole DuckDB connection, so all reads route
  //    through its own RW connection instead of a conflicting cross-process
  //    READ_ONLY attach) ──
  "getFanIn",
  "getFanInP95",
  "getFanOut",
  "getCallers",
  "getCallees",
  "getAmbiguousCallersByMember",
  "getCalleeEdges",
  "getCalleeEdgesScoped",
  "getSymbolRelPaths",
  "getCalledByCount",
  "getCallSiteCount",
  "getChunkSignalsBulk",
  "hasData",
  "getRunStats",
  "getEdgeKindDistribution",
  "listAllSymbols",
  "listAllPass1Aggregates",
  "listFileContentHashes",
  "getTransitiveImpact",
  "getFileMetricsBulk",
  "findCycles",
  "listAdjacency",
  "getPageRank",
  "findSymbolChunk",
  // Per-file symbol line ranges for the payload healer's chunk-owner rule
  // (bd tea-rags-mcp-9i2ow). Its own op, so a daemon from an older build answers
  // "unknown daemon op" — a tolerated legacy op, see `LEGACY_TOLERATED_OPS`.
  "getSymbolLineRangesBulk",
  // Read half of the drift pair (bd tea-rags-mcp-a2ddb). Plain arrays on the
  // wire — no Map, so no entries() dance on either side.
  "diffSymbolSignals",
  // ── class hierarchy (bd tea-rags-mcp-f10y) ──
  "getSupertypes",
  "getSubtypes",
  "getTransitiveSubtypes",
  "loadHierarchySnapshot",
] as const;

export type DaemonOp = (typeof DAEMON_OPS)[number];

export interface DaemonRequest {
  id: number;
  op: DaemonOp;
  params:
    | { collection: string } // checkpoint | rebuildEdgeFileTargetIndex | computeAndPersistCyclesAndSignals | hasData | getRunStats | listAllSymbols | listFileContentHashes | getChunkSignalsBulk | diffSymbolSignals | refreshSymbolSignalsPrev | shutdown | ping
    | { collection: string; buildFingerprint?: string } // handshake (fingerprint absent on legacy peers)
    | { collection: string; node: GraphFileNode; edges: GraphEdges } // upsertFile
    | { collection: string; relPath: RelPath } // removeFile | removeSymbolsForFile | getFanIn | getFanOut
    | { collection: string; relPath: RelPath; definitions: SymbolDefinition[] } // upsertSymbols
    | { collection: string; entries: BulkSymbolUpsertEntry[] } // upsertSymbolsBulk
    | { collection: string; entries: BulkFileUpsertEntry[] } // upsertFilesBulk
    | { collection: string; relPath: RelPath; chunkIds: [string, string][] } // updateSymbolChunkIds
    | { collection: string; entries: { relPath: RelPath; chunkIds: [string, string][] }[] } // updateSymbolChunkIdsBulk
    | { collection: string; relPath: RelPath; maxDepth?: number } // getTransitiveImpact
    | { collection: string; relPaths: RelPath[]; maxDepth?: number } // getFileMetricsBulk | getSymbolLineRangesBulk (no maxDepth)
    | { collection: string; oldVersion: string; newVersion: string } // finalizeReindex
    | { collection: string; symbolId: SymbolId } // getCallers | getCallees | getCalledByCount | getCallSiteCount | getPageRank
    | { collection: string; member: string; limit?: number } // getAmbiguousCallersByMember
    | { collection: string; symbolIds: SymbolId[] } // getCalleeEdges | getSymbolRelPaths
    | { collection: string; refs: FileScopedSymbolRef[] } // getCalleeEdgesScoped
    | { collection: string; scope: CycleScope; pathPattern?: string } // findCycles (pathPattern) | listAdjacency
    | { collection: string; scope: CycleScope; sccs: readonly (readonly string[])[] } // replaceCycles
    | { collection: string; ranks: [string, number][] } // replacePageRanks
    | { collection: string; rows: ResolveRunStatsRow[] } // recordRunStats
    | { collection: string; write: FileResolveStatsWrite } // recordFileResolveStats
    | { collection: string; fqName: string }; // getSupertypes | getSubtypes | getTransitiveSubtypes
}

/**
 * `handshake` op result. A legacy daemon (pre-fingerprint build) returns null
 * instead — the client treats a missing fingerprint as "no restart".
 */
export interface DaemonHandshakeResult {
  buildFingerprint?: string;
  /**
   * Every op the daemon's dispatch table serves (bd tea-rags-mcp-39xca.4) — read
   * from the table the server actually dispatches on, so a daemon advertises
   * what it can answer, not what the protocol names. Plain strings: a newer
   * daemon may serve ops this client has never heard of. Absent on a daemon
   * that predates capability advertisement.
   */
  supportedOps?: readonly string[];
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
