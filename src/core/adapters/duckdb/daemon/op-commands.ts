import type {
  BulkFileUpsertEntry,
  BulkSymbolUpsertEntry,
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  ResolveRunStatsRow,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import type { GraphDbClientPool } from "../pool.js";
import { computeAndPersistCyclesAndSignals } from "./graph-analysis.js";
import type { DaemonHandshakeResult, DaemonOp } from "./protocol.js";

/**
 * A request's params as they come off the wire. The `DaemonRequest["params"]`
 * union is per-op, so each command narrows the fields it needs itself — same
 * cast-at-use idiom the switch statement this table replaced used.
 */
type DaemonOpParams = Record<string, unknown>;

/**
 * Everything a command needs that is NOT a pooled `graphDb`: the pool itself
 * (collection lifecycle) and the daemon's build identity (handshake).
 */
export interface DaemonOpContext {
  readonly pool: GraphDbClientPool;
  readonly buildFingerprint: string;
}

/**
 * One entry of the daemon's protocol surface. `access` is data, not control
 * flow, so the dispatcher — not each op — decides how the handle is acquired:
 *
 * - `write` — pooled handle + memory-governor notification (write-burst scoped)
 * - `read`  — pooled handle, no governor (the daemon owns the sole connection,
 *             so reads route through its own RW connection too)
 * - `daemon` — no handle at all; the op acts on the daemon itself
 */
export type DaemonOpCommand =
  | { readonly access: "read" | "write"; readonly run: (graphDb: GraphDbClient, p: DaemonOpParams) => Promise<unknown> }
  | { readonly access: "daemon"; readonly run: (ctx: DaemonOpContext, p: DaemonOpParams) => Promise<unknown> };

/** A write op: governed handle, and the wire result is always a `null` ack. */
function write(run: (graphDb: GraphDbClient, p: DaemonOpParams) => Promise<void>): DaemonOpCommand {
  return {
    access: "write",
    run: async (graphDb, p) => {
      await run(graphDb, p);
      return null;
    },
  };
}

/** A read op: pooled handle, result forwarded to the client as-is. */
function read(run: (graphDb: GraphDbClient, p: DaemonOpParams) => Promise<unknown>): DaemonOpCommand {
  return { access: "read", run };
}

/**
 * The daemon's protocol surface, one entry per `DaemonOp`. Keyed by
 * `Record<DaemonOp, …>` on purpose: adding an op to the protocol union without
 * a command here is a compile error, and the table is greppable/enumerable in
 * a way the 200-line switch it replaced was not.
 */
export const DAEMON_OP_COMMANDS: Readonly<Record<DaemonOp, DaemonOpCommand>> = {
  handshake: {
    access: "daemon",
    run: async (ctx, p) => {
      const clientFingerprint = p.buildFingerprint as string | undefined;
      // A client from a DIFFERENT build is about to drain-restart this
      // daemon — do NOT open/migrate the DB with stale code first. Legacy
      // clients (no fingerprint) keep the original open-on-handshake path.
      if (clientFingerprint === undefined || clientFingerprint === ctx.buildFingerprint) {
        await ctx.pool.acquire(p.collection as string); // opens + migrates + hydrates
      }
      return { buildFingerprint: ctx.buildFingerprint } satisfies DaemonHandshakeResult;
    },
  },
  shutdown: {
    access: "daemon",
    // Transport-level op: daemon/entry.ts acks it and reuses the
    // idle-watcher drain/exit path. Reaching the dispatcher means the
    // transport interception is miswired — a caller bug, not a user error.
    run: async () => {
      throw new Error("shutdown is handled by the daemon transport (entry.ts), not the request dispatcher");
    },
  },
  finalizeReindex: {
    access: "daemon",
    // The Qdrant alias swap (adapters/qdrant/aliases.ts:switchAlias) has
    // already flipped readers onto newVersion; delete the superseded
    // oldVersion DuckDB file (+ WAL sidecar) so it does not outlive the
    // collection it shadowed. `removeCollection` closes any pooled handle
    // first, then unlinks the file — crash-safe: old stays intact until swap.
    run: async (ctx, p) => {
      await ctx.pool.removeCollection(p.oldVersion as string);
      return null;
    },
  },

  // ── writes ──
  upsertFile: write(async (graphDb, p) => graphDb.upsertFile(p.node as GraphFileNode, p.edges as GraphEdges)),
  removeFile: write(async (graphDb, p) => graphDb.removeFile(p.relPath as RelPath)),
  removeSymbolsForFile: write(async (graphDb, p) => graphDb.removeSymbolsForFile(p.relPath as RelPath)),
  upsertSymbols: write(async (graphDb, p) =>
    graphDb.upsertSymbols(p.relPath as RelPath, p.definitions as SymbolDefinition[]),
  ),
  upsertSymbolsBulk: write(async (graphDb, p) => graphDb.upsertSymbolsBulk(p.entries as BulkSymbolUpsertEntry[])),
  upsertFilesBulk: write(async (graphDb, p) => graphDb.upsertFilesBulk(p.entries as BulkFileUpsertEntry[])),
  // entries → Map (mirrors replacePageRanks rebuild).
  updateSymbolChunkIds: write(async (graphDb, p) =>
    graphDb.updateSymbolChunkIds(p.relPath as RelPath, new Map(p.chunkIds as [SymbolId, string][])),
  ),
  replaceCycles: write(async (graphDb, p) =>
    graphDb.replaceCycles(p.scope as CycleScope, p.sccs as readonly (readonly string[])[]),
  ),
  // Ranks ride the wire as `[symbolId, rank][]` entries (a Map cannot
  // JSON-serialise) — rebuild the Map before delegating to the adapter.
  replacePageRanks: write(async (graphDb, p) => graphDb.replacePageRanks(new Map(p.ranks as [string, number][]))),
  checkpoint: write(async (graphDb) => graphDb.checkpoint()),
  rebuildEdgeFileTargetIndex: write(async (graphDb) => graphDb.rebuildEdgeFileTargetIndex()),
  recordRunStats: write(async (graphDb, p) => graphDb.recordRunStats(p.rows as ResolveRunStatsRow[])),
  computeAndPersistCyclesAndSignals: write(async (graphDb) => computeAndPersistCyclesAndSignals(graphDb)),

  // ── full-proxy reads (the daemon owns the sole DuckDB connection, so
  //    every read routes through its own RW connection) ──
  getFanIn: read(async (graphDb, p) => graphDb.getFanIn(p.relPath as RelPath)),
  getFanInP95: read(async (graphDb) => graphDb.getFanInP95()),
  getFanOut: read(async (graphDb, p) => graphDb.getFanOut(p.relPath as RelPath)),
  getCallers: read(async (graphDb, p) => graphDb.getCallers(p.symbolId as SymbolId)),
  getAmbiguousCallersByMember: read(async (graphDb, p) =>
    graphDb.getAmbiguousCallersByMember(p.member as string, p.limit as number | undefined),
  ),
  findSymbolChunk: read(async (graphDb, p) => graphDb.findSymbolChunk(p.symbolId as SymbolId)),
  getCallees: read(async (graphDb, p) => graphDb.getCallees(p.symbolId as SymbolId)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getCalleeEdges: read(async (graphDb, p) => [...(await graphDb.getCalleeEdges(p.symbolIds as SymbolId[])).entries()]),
  getCalledByCount: read(async (graphDb, p) => graphDb.getCalledByCount(p.symbolId as SymbolId)),
  getCallSiteCount: read(async (graphDb, p) => graphDb.getCallSiteCount(p.symbolId as SymbolId)),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getChunkSignalsBulk: read(async (graphDb) => [...(await graphDb.getChunkSignalsBulk()).entries()]),
  hasData: read(async (graphDb) => graphDb.hasData()),
  getRunStats: read(async (graphDb) => graphDb.getRunStats()),
  getEdgeKindDistribution: read(async (graphDb) => graphDb.getEdgeKindDistribution()),
  listAllSymbols: read(async (graphDb) => graphDb.listAllSymbols()),
  listFileContentHashes: read(async (graphDb) => graphDb.listFileContentHashes()),
  getTransitiveImpact: read(async (graphDb, p) =>
    graphDb.getTransitiveImpact(p.relPath as RelPath, p.maxDepth as number | undefined),
  ),
  // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
  getFileMetricsBulk: read(async (graphDb, p) => [
    ...(await graphDb.getFileMetricsBulk(p.relPaths as RelPath[], p.maxDepth as number | undefined)).entries(),
  ]),
  findCycles: read(async (graphDb, p) =>
    graphDb.findCycles(p.scope as CycleScope, p.pathPattern as string | undefined),
  ),
  // The adapter returns a `Map<string, string[]>`; serialise as entries
  // so it survives JSON framing (the client rebuilds the Map).
  listAdjacency: read(async (graphDb, p) => [...(await graphDb.listAdjacency(p.scope as CycleScope)).entries()]),
  getPageRank: read(async (graphDb, p) => graphDb.getPageRank(p.symbolId as SymbolId)),

  // ── class hierarchy (bd tea-rags-mcp-f10y) ──
  getSupertypes: read(async (graphDb, p) => graphDb.getSupertypes(p.fqName as string)),
  getSubtypes: read(async (graphDb, p) => graphDb.getSubtypes(p.fqName as string)),
  getTransitiveSubtypes: read(async (graphDb, p) => graphDb.getTransitiveSubtypes(p.fqName as string)),
  // HierarchySnapshot is plain Records — JSON-serialisable, no entries() dance.
  loadHierarchySnapshot: read(async (graphDb) => graphDb.loadHierarchySnapshot()),
};
