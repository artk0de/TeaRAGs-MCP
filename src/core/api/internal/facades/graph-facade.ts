/**
 * GraphFacade — thin orchestrator over the per-collection
 * `GraphDbClientPool` for the MCP graph tools (`get_callers`,
 * `get_callees`, `find_cycles`).
 *
 * Per `.claude/rules/facade-discipline.md` the facade only validates
 * input and delegates. The body is intentionally tiny — when result
 * shaping grows past 20 lines (e.g. attaching `ChunkPreview` payloads
 * from `find_symbol`), extract a `GraphOps` class. Slice 1+2's reads
 * are direct table reads so the facade itself is enough.
 *
 * Collection routing: each MCP request carries a `path` (the indexed
 * codebase) which resolves to a Qdrant collection name via
 * `resolveCollectionName`. The facade pulls the per-collection DuckDB
 * handle from the pool. When the pool can't open the file (lock held
 * by another process, or the collection has never been indexed) the
 * facade surfaces empty results — the graph tool degrades gracefully
 * instead of crashing the whole MCP request.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import { resolveCollectionName } from "../../../infra/collection-name.js";
import type {
  FindCyclesRequest,
  FindCyclesResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
} from "../../public/dto/graph.js";

export interface GraphFacadeDeps {
  pool: GraphDbClientPool;
}

const DEFAULT_LIMIT = 50;

export class GraphFacade {
  constructor(private readonly deps: GraphFacadeDeps) {}

  /**
   * Acquire the per-collection handle for the request's `path`. Returns
   * `undefined` when the underlying DuckDB cannot be opened — caller
   * surfaces an empty response rather than propagating the lock /
   * I/O error to MCP.
   */
  private async acquireForPath(path: string): Promise<CollectionGraphHandle | undefined> {
    const collectionName = resolveCollectionName(path);
    try {
      return await this.deps.pool.acquire(collectionName);
    } catch {
      return undefined;
    }
  }

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    const handle = await this.acquireForPath(req.path);
    if (!handle) return { callers: [] };
    const edges = await handle.graphDb.getCallers(req.symbolId);
    return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    const handle = await this.acquireForPath(req.path);
    if (!handle) return { callees: [] };
    const edges = await handle.graphDb.getCallees(req.symbolId);
    return { callees: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    const handle = await this.acquireForPath(req.path);
    if (!handle) return { cycles: [] };
    const entries = await handle.graphDb.findCycles(req.scope);
    return {
      cycles: entries.map((e) => ({
        cycleId: e.cycleId,
        scope: e.scope,
        members: e.members,
        length: e.members.length,
      })),
    };
  }
}
