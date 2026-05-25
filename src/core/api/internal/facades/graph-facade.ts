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
 * Collection routing: each MCP request carries the shared
 * `{ collection, project, path }` triad (resolution priority:
 * `collection > project > path`) — same shape every other tea-rags
 * tool accepts (`find_symbol`, `semantic_search`, etc.). The facade
 * resolves it through `resolveCollection` to a Qdrant collection name
 * and pulls the per-collection DuckDB handle from the pool. When the
 * pool can't open the file (lock held by another process, or the
 * collection has never been indexed) the facade surfaces empty results
 * — the graph tool degrades gracefully instead of crashing the whole
 * MCP request. Resolution-level errors (no addressing at all, unknown
 * project alias) are typed `InputValidationError` subclasses and bubble
 * to the MCP error middleware so the caller sees a clear schema-level
 * message rather than a silent empty list.
 */

import type { CollectionGraphHandle, GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import { resolveCollection } from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/index.js";
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
  collectionRegistry: CollectionRegistry;
}

const DEFAULT_LIMIT = 50;

interface GraphAddressing {
  collection?: string;
  project?: string;
  path?: string;
}

export class GraphFacade {
  constructor(private readonly deps: GraphFacadeDeps) {}

  /**
   * Resolve the `{ collection, project, path }` triad to a Qdrant
   * collection name (throws typed `InputValidationError` on missing
   * address or unknown project alias) and acquire the per-collection
   * DuckDB handle. Returns `undefined` only on pool-level I/O failure
   * (lock held, file missing, init error) — that's the empty-result
   * fallback the codegraph spec mandates. Resolution-level errors
   * propagate so the MCP middleware can surface them as schema errors.
   */
  private async acquire(addr: GraphAddressing): Promise<CollectionGraphHandle | undefined> {
    const { collectionName } = resolveCollection(this.deps.collectionRegistry, addr);
    try {
      return await this.deps.pool.acquire(collectionName);
    } catch {
      return undefined;
    }
  }

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    const handle = await this.acquire(req);
    if (!handle) return { callers: [] };
    const edges = await handle.graphDb.getCallers(req.symbolId);
    return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    const handle = await this.acquire(req);
    if (!handle) return { callees: [] };
    const edges = await handle.graphDb.getCallees(req.symbolId);
    return { callees: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    const handle = await this.acquire(req);
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
