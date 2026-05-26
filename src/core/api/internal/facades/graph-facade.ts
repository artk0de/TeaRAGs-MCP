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
   * Acquire a per-collection READ-ONLY handle for the request's `path` and run
   * `fn` against it, always closing the handle afterwards. Reads route through
   * `pool.acquireRead` — an in-process READ_ONLY DuckDB attach that does NOT
   * contend with the daemon's RW lock (DuckDB permits unlimited concurrent
   * cross-process readers). `acquireRead` returns a NON-cached client the caller
   * MUST close, so every read opens-queries-closes in one bounded scope.
   *
   * Returns `fallback` when the underlying DuckDB cannot be opened (lock held,
   * missing file, init failure) — the graph tool degrades to an empty result
   * rather than propagating the I/O error to the MCP request.
   */
  private async withReadHandle<T>(
    path: string,
    fn: (handle: CollectionGraphHandle) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const collectionName = resolveCollectionName(path);
    let handle: CollectionGraphHandle | undefined;
    try {
      handle = await this.deps.pool.acquireRead(collectionName);
    } catch {
      return fallback;
    }
    try {
      return await fn(handle);
    } finally {
      await handle.graphDb.close().catch(() => undefined);
    }
  }

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    return this.withReadHandle(
      req.path,
      async (handle) => {
        const edges = await handle.graphDb.getCallers(req.symbolId);
        return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
      },
      { callers: [] },
    );
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    return this.withReadHandle(
      req.path,
      async (handle) => {
        const edges = await handle.graphDb.getCallees(req.symbolId);
        return { callees: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
      },
      { callees: [] },
    );
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    return this.withReadHandle(
      req.path,
      async (handle) => {
        const entries = await handle.graphDb.findCycles(req.scope);
        return {
          cycles: entries.map((e) => ({
            cycleId: e.cycleId,
            scope: e.scope,
            members: e.members,
            length: e.members.length,
          })),
        };
      },
      { cycles: [] },
    );
  }
}
