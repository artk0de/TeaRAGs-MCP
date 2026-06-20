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
import type { SymbolChunkLocation, SymbolId } from "../../../contracts/types/codegraph.js";
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
  /**
   * Resolve an addressed collection name to the ACTIVE underlying collection.
   * The codegraph DuckDB files are versioned (`code_x_v4.duckdb`) while the
   * project/registry addresses the stable Qdrant alias (`code_x`); Qdrant
   * resolves the alias transparently server-side, but the codegraph pool opens
   * a DuckDB file by literal name, so the alias must be expanded to the active
   * versioned collection the write path populated — otherwise reads open the
   * empty unversioned file and return nothing. Wired to
   * `qdrant.aliases.resolveActive` in the composition root. Optional: when
   * absent (unit tests), the name is used verbatim.
   */
  resolveActiveCollection?: (collectionName: string) => Promise<string>;
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
   * Resolve the request's address triad ({ collection, project, path }) to a
   * Qdrant collection name via the registry (resolution-level errors propagate
   * as typed `InputValidationError` so the MCP middleware surfaces them), then
   * acquire a per-collection READ handle and run `fn` against it, always closing
   * the handle afterwards. Reads route through `pool.acquireReader` — mode-aware:
   * in production a daemon client that PROXIES the read through the daemon's own
   * RW connection (DuckDB's RW lock is process-exclusive, so a cross-process
   * READ_ONLY attach throws "Conflicting lock is held" while the daemon holds
   * RW); in direct/test mode an in-process READ_ONLY attach. The handle is
   * NON-cached and MUST be closed, so every read opens-queries-closes in one
   * bounded scope. Returns `fallback` only on pool-level acquire failure (daemon
   * unreachable, lock held, missing file, init error).
   */
  private async withReadHandle<T>(
    addr: GraphAddressing,
    fn: (handle: CollectionGraphHandle) => Promise<T>,
    fallback: T,
  ): Promise<T> {
    const { collectionName } = resolveCollection(this.deps.collectionRegistry, addr);
    // Expand a Qdrant alias to the active versioned collection so the codegraph
    // pool opens the DuckDB file the write path actually populated (see
    // resolveActiveCollection doc). Resolution failure falls back to the
    // addressed name rather than aborting the read.
    const activeCollection = this.deps.resolveActiveCollection
      ? await this.deps.resolveActiveCollection(collectionName).catch(() => collectionName)
      : collectionName;
    let handle: CollectionGraphHandle | undefined;
    try {
      handle = await this.deps.pool.acquireReader(activeCollection);
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
      req,
      async (handle) => {
        const edges = await handle.graphDb.getCallers(req.symbolId);
        return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
      },
      { callers: [] },
    );
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    return this.withReadHandle(
      req,
      async (handle) => {
        const edges = await handle.graphDb.getCallees(req.symbolId);
        return { callees: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
      },
      { callees: [] },
    );
  }

  async resolveSymbolChunk(addr: GraphAddressing, symbolId: SymbolId): Promise<SymbolChunkLocation | null> {
    return this.withReadHandle(addr, async (handle) => handle.graphDb.findSymbolChunk(symbolId), null);
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    return this.withReadHandle(
      req,
      async (handle) => {
        const entries = await handle.graphDb.findCycles(req.scope, req.pathPattern);
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
