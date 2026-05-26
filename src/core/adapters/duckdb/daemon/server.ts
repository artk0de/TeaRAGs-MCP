import type {
  CycleScope,
  GraphDbClient,
  GraphEdges,
  GraphFileNode,
  RelPath,
  SymbolDefinition,
  SymbolId,
} from "../../../contracts/types/codegraph.js";
import { pageRank } from "../../../infra/graph/page-rank.js";
import { tarjanScc } from "../../../infra/graph/tarjan-scc.js";
import type { GraphDbClientPool } from "../pool.js";
import type { DaemonRequest, DaemonResponse } from "./protocol.js";

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
  constructor(private readonly pool: GraphDbClientPool) {}

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
      case "handshake":
        await this.pool.acquire(collection); // opens + migrates + hydrates
        return null;
      // ── writes ──
      case "upsertFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.upsertFile(p.node as GraphFileNode, p.edges as GraphEdges);
        return null;
      }
      case "removeFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.removeFile(p.relPath as RelPath);
        return null;
      }
      case "removeSymbolsForFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.removeSymbolsForFile(p.relPath as RelPath);
        return null;
      }
      case "upsertSymbols": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.upsertSymbols(p.relPath as RelPath, p.definitions as SymbolDefinition[]);
        return null;
      }
      case "replaceCycles": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.replaceCycles(p.scope as CycleScope, p.sccs as readonly (readonly string[])[]);
        return null;
      }
      case "replacePageRanks": {
        const { graphDb } = await this.pool.acquire(collection);
        // Ranks ride the wire as `[symbolId, rank][]` entries (a Map cannot
        // JSON-serialise) — rebuild the Map before delegating to the adapter.
        await graphDb.replacePageRanks(new Map(p.ranks as [string, number][]));
        return null;
      }
      case "checkpoint": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.checkpoint();
        return null;
      }
      case "computeAndPersistCyclesAndSignals": {
        const { graphDb } = await this.pool.acquire(collection);
        await computeAndPersistCyclesAndSignals(graphDb);
        return null;
      }
      // ── full-proxy reads (the daemon owns the sole DuckDB connection, so
      //    every read routes through its own RW connection) ──
      case "getFanIn": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getFanIn(p.relPath as RelPath);
      }
      case "getFanOut": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getFanOut(p.relPath as RelPath);
      }
      case "getCallers": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallers(p.symbolId as SymbolId);
      }
      case "getCallees": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallees(p.symbolId as SymbolId);
      }
      case "getCalledByCount": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCalledByCount(p.symbolId as SymbolId);
      }
      case "getCallSiteCount": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.getCallSiteCount(p.symbolId as SymbolId);
      }
      case "hasData": {
        const { graphDb } = await this.pool.acquire(collection);
        return graphDb.hasData();
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
        return graphDb.findCycles(p.scope as CycleScope);
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
  await graphDb.replaceCycles("file", tarjanScc(fileAdj));
  const methodAdj = await collectAdjacency(graphDb, "method");
  await graphDb.replaceCycles("method", tarjanScc(methodAdj));
  await graphDb.replacePageRanks(pageRank(methodAdj).ranks);
}

/**
 * Drain `graphDb.streamAdjacency(scope)` into the compact
 * `Map<string, string[]>` shape that `tarjanScc` and `pageRank` consume —
 * building the Map exactly once instead of letting the adapter pre-bucket.
 */
async function collectAdjacency(graphDb: GraphDbClient, scope: CycleScope): Promise<Map<string, string[]>> {
  const adj = new Map<string, string[]>();
  for await (const [source, target] of graphDb.streamAdjacency(scope)) {
    const list = adj.get(source);
    if (list) list.push(target);
    else adj.set(source, [target]);
  }
  return adj;
}
