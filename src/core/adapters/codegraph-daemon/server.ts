import type { GraphDbClientPool } from "../duckdb/pool.js";
import type { DaemonRequest, DaemonResponse } from "./protocol.js";
import { tarjanScc } from "../../domains/trajectory/codegraph/infra/tarjan-scc.js";
import { pageRank } from "../../domains/trajectory/codegraph/infra/page-rank.js";
import type { GraphDbClient, CycleScope } from "../../contracts/types/codegraph.js";

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
      case "upsertFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.upsertFile(p.node as never, p.edges as never);
        return null;
      }
      case "removeSymbolsForFile": {
        const { graphDb } = await this.pool.acquire(collection);
        await graphDb.removeSymbolsForFile(p.relPath as string);
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
