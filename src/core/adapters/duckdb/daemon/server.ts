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
import { pageRank } from "../../../infra/graph/page-rank.js";
import { tarjanScc } from "../../../infra/graph/tarjan-scc.js";
import type { CollectionGraphHandle, GraphDbClientPool } from "../pool.js";
import { getBuildFingerprint } from "./build-fingerprint.js";
import type { DaemonMemoryGovernor } from "./memory-governor.js";
import type { DaemonHandshakeResult, DaemonRequest, DaemonResponse } from "./protocol.js";

/**
 * In-process request handler for the codegraph daemon. Owns the internal
 * read-write `GraphDbClientPool`; every `DaemonRequest` is dispatched
 * against the pooled `graphDb` for its collection. Heavy graph analysis
 * (`computeAndPersistCyclesAndSignals`) runs here — confined to the single
 * daemon process so the ~30 GB collectAdjacency/Tarjan/PageRank allocation
 * never multiplies across MCP client processes, and so cross-process
 * single-writer DuckDB lock contention is eliminated at the source.
 *
 * The transport layer (socket framing in `entry.ts`, Task 9) wraps this:
 * `handle` is pure request → response and never throws — failures surface
 * as `{ ok: false, error }` so the socket loop can keep serving.
 */
export class CodegraphDaemonServer {
  constructor(
    private readonly pool: GraphDbClientPool,
    /**
     * This daemon's build identity, returned in every handshake response so a
     * client from a different build can decide to drain-restart the daemon
     * (bd tea-rags-mcp-ji56r). Injectable for tests; defaults to the shared
     * module-computed fingerprint (env-overridable).
     */
    private readonly buildFingerprint: string = getBuildFingerprint(),
    /**
     * Optional adaptive memory governor (bd tea-rags-mcp-1ruih). When wired,
     * every write op notifies it so the FIRST write of an ingest burst raises
     * the DuckDB memory_limit to the configured ceiling. Reads never notify —
     * the governor is write-burst-scoped by design.
     */
    private readonly governor?: DaemonMemoryGovernor,
  ) {}

  /**
   * Acquire the pooled handle for a WRITE op and notify the memory governor
   * (`onWrite` is a no-op for already-raised collections — one live SET per
   * burst). `finalizeReindex` does NOT route through here: it only unlinks the
   * superseded DB file, so there is no open handle to govern.
   */
  private async acquireForWrite(collection: string): Promise<CollectionGraphHandle> {
    const handle = await this.pool.acquire(collection);
    await this.governor?.onWrite(collection, handle.graphDb);
    return handle;
  }

  async handle(req: DaemonRequest): Promise<DaemonResponse> {
    try {
      const result = await this.dispatch(req);
      return { id: req.id, ok: true, result };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      return { id: req.id, ok: false, error: { name: e.name, message: e.message } };
    }
  }

  private async dispatch(req: DaemonRequest): Promise<unknown> {
    const p = req.params as Record<string, unknown>;
    const collection = p.collection as string;
    switch (req.op) {
      case "handshake": {
        const clientFingerprint = p.buildFingerprint as string | undefined;
        // A client from a DIFFERENT build is about to drain-restart this
        // daemon — do NOT open/migrate the DB with stale code first. Legacy
        // clients (no fingerprint) keep the original open-on-handshake path.
        if (clientFingerprint === undefined || clientFingerprint === this.buildFingerprint) {
          await this.pool.acquire(collection); // opens + migrates + hydrates
        }
        return { buildFingerprint: this.buildFingerprint } satisfies DaemonHandshakeResult;
      }
      case "shutdown":
        // Transport-level op: daemon/entry.ts acks it and reuses the
        // idle-watcher drain/exit path. Reaching the dispatcher means the
        // transport interception is miswired — a caller bug, not a user error.
        throw new Error("shutdown is handled by the daemon transport (entry.ts), not the request dispatcher");
      // ── writes ──
      case "upsertFile": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.upsertFile(p.node as GraphFileNode, p.edges as GraphEdges);
        return null;
      }
      case "removeFile": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.removeFile(p.relPath as RelPath);
        return null;
      }
      case "removeSymbolsForFile": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.removeSymbolsForFile(p.relPath as RelPath);
        return null;
      }
      case "upsertSymbols": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.upsertSymbols(p.relPath as RelPath, p.definitions as SymbolDefinition[]);
        return null;
      }
      case "upsertSymbolsBulk": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.upsertSymbolsBulk(p.entries as BulkSymbolUpsertEntry[]);
        return null;
      }
      case "upsertFilesBulk": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.upsertFilesBulk(p.entries as BulkFileUpsertEntry[]);
        return null;
      }
      case "updateSymbolChunkIds": {
        const { graphDb } = await this.acquireForWrite(collection);
        // entries → Map (mirrors replacePageRanks rebuild).
        await graphDb.updateSymbolChunkIds(p.relPath as RelPath, new Map(p.chunkIds as [SymbolId, string][]));
        return null;
      }
      case "replaceCycles": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.replaceCycles(p.scope as CycleScope, p.sccs as readonly (readonly string[])[]);
        return null;
      }
      case "replacePageRanks": {
        const { graphDb } = await this.acquireForWrite(collection);
        // Ranks ride the wire as `[symbolId, rank][]` entries (a Map cannot
        // JSON-serialise) — rebuild the Map before delegating to the adapter.
        await graphDb.replacePageRanks(new Map(p.ranks as [string, number][]));
        return null;
      }
      case "checkpoint": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.checkpoint();
        return null;
      }
      case "recordRunStats": {
        const { graphDb } = await this.acquireForWrite(collection);
        await graphDb.recordRunStats(p.rows as ResolveRunStatsRow[]);
        return null;
      }
      case "computeAndPersistCyclesAndSignals": {
        const { graphDb } = await this.acquireForWrite(collection);
        await computeAndPersistCyclesAndSignals(graphDb);
        return null;
      }
      // ── full-proxy reads (the daemon owns the sole DuckDB connection, so
      //    every read routes through its own RW connection) ──
      case "getFanIn": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getFanIn(p.relPath as RelPath);
      }
      case "getFanInP95": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getFanInP95();
      }
      case "getFanOut": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getFanOut(p.relPath as RelPath);
      }
      case "getCallers": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallers(p.symbolId as SymbolId);
      }
      case "getAmbiguousCallersByMember": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getAmbiguousCallersByMember(p.member as string, p.limit as number | undefined);
      }
      case "findSymbolChunk": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.findSymbolChunk(p.symbolId as SymbolId);
      }
      case "getCallees": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallees(p.symbolId as SymbolId);
      }
      case "getCalleeEdges": {
        const { graphDb } = await this.pool.acquire(collection);
        // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
        const adj = await graphDb.getCalleeEdges(p.symbolIds as SymbolId[]);
        return [...adj.entries()];
      }
      case "getCalledByCount": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCalledByCount(p.symbolId as SymbolId);
      }
      case "getCallSiteCount": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallSiteCount(p.symbolId as SymbolId);
      }
      case "getChunkSignalsBulk": {
        const { graphDb } = await this.pool.acquire(collection);
        // Map cannot JSON-serialise — emit entries; the client rebuilds the Map.
        const sig = await graphDb.getChunkSignalsBulk();
        return [...sig.entries()];
      }
      case "hasData": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.hasData();
      }
      case "getRunStats": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getRunStats();
      }
      case "getEdgeKindDistribution": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getEdgeKindDistribution();
      }
      case "listAllSymbols": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.listAllSymbols();
      }
      case "getTransitiveImpact": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getTransitiveImpact(p.relPath as RelPath, p.maxDepth as number | undefined);
      }
      case "findCycles": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.findCycles(p.scope as CycleScope, p.pathPattern as string | undefined);
      }
      case "listAdjacency": {
        const { graphDb } = await this.pool.acquire(collection);
        // The adapter returns a `Map<string, string[]>`; serialise as entries
        // so it survives JSON framing (the client rebuilds the Map).
        const adj = await graphDb.listAdjacency(p.scope as CycleScope);
        return [...adj.entries()];
      }
      case "getPageRank": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getPageRank(p.symbolId as SymbolId);
      }
      // ── class hierarchy (bd tea-rags-mcp-f10y) ──
      case "getSupertypes": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getSupertypes(p.fqName as string);
      }
      case "getSubtypes": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getSubtypes(p.fqName as string);
      }
      case "getTransitiveSubtypes": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getTransitiveSubtypes(p.fqName as string);
      }
      case "loadHierarchySnapshot": {
        const { graphDb } = await this.pool.acquire(collection);
        // HierarchySnapshot is plain Records — JSON-serialisable, no entries() dance.
        return graphDb.loadHierarchySnapshot();
      }
      case "finalizeReindex":
        // The Qdrant alias swap (adapters/qdrant/aliases.ts:switchAlias) has
        // already flipped readers onto newVersion; delete the superseded
        // oldVersion DuckDB file (+ WAL sidecar) so it does not outlive the
        // collection it shadowed. `removeCollection` closes any pooled handle
        // first, then unlinks the file — crash-safe: old stays intact until swap.
        await this.pool.removeCollection(p.oldVersion as string);
        return null;
      default:
        throw new Error(`unknown daemon op: ${String(req.op)}`);
    }
  }
}

/**
 * Run SCC (file + method scopes) and PageRank over the whole graph and
 * persist the results. Moved verbatim from `provider.ts`'s
 * `recomputeGraphMetricsStreaming` body so the heavy pass executes daemon-side.
 */
export async function computeAndPersistCyclesAndSignals(graphDb: GraphDbClient): Promise<void> {
  const fileAdj = await collectAdjacency(graphDb, "file");
  await graphDb.replaceCycles("file", tarjanScc(fileAdj.adjacency));
  const methodAdj = await collectAdjacency(graphDb, "method");
  // Tarjan SCC stays unweighted — cycle detection is structural. PageRank is
  // confidence-weighted (bd tea-rags-mcp-s5ato): an m-way dynamic fan-out at
  // confidence 1/m distributes ONE call site's rank across the fan, not m.
  await graphDb.replaceCycles("method", tarjanScc(methodAdj.adjacency));
  await graphDb.replacePageRanks(pageRank(methodAdj.adjacency, { weights: methodAdj.edgeWeights }).ranks);
}

/**
 * Drain `graphDb.streamAdjacency(scope)` into the compact
 * `Map<string, string[]>` shape that `tarjanScc` and `pageRank` consume —
 * building the Map exactly once instead of letting the adapter pre-bucket.
 * The per-edge confidence (third stream element, method scope only) is
 * bucketed into an index-aligned weight map for the weighted PageRank pass;
 * absent weights (file scope, legacy rows) default to 1.
 */
async function collectAdjacency(
  graphDb: GraphDbClient,
  scope: CycleScope,
): Promise<{ adjacency: Map<string, string[]>; edgeWeights: Map<string, number[]> }> {
  const adjacency = new Map<string, string[]>();
  const edgeWeights = new Map<string, number[]>();
  for await (const [source, target, weight] of graphDb.streamAdjacency(scope)) {
    const list = adjacency.get(source);
    const wList = edgeWeights.get(source);
    if (list && wList) {
      list.push(target);
      wList.push(weight ?? 1);
    } else {
      adjacency.set(source, [target]);
      edgeWeights.set(source, [weight ?? 1]);
    }
  }
  return { adjacency, edgeWeights };
}
