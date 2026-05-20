/**
 * GraphFacade — thin orchestrator over `GraphDbClient` for the MCP
 * graph tools (`get_callers`, `get_callees`, `find_cycles`).
 *
 * Per `.claude/rules/facade-discipline.md` the facade only validates
 * input and delegates. The body is intentionally tiny — when result
 * shaping grows past 20 lines (e.g. attaching `ChunkPreview` payloads
 * from `find_symbol`), extract a `GraphOps` class. Slice 1+2's reads
 * are direct table reads so the facade itself is enough.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import type {
  FindCyclesRequest,
  FindCyclesResponse,
  GetCalleesRequest,
  GetCalleesResponse,
  GetCallersRequest,
  GetCallersResponse,
} from "../../public/dto/graph.js";

export interface GraphFacadeDeps {
  graphDb: GraphDbClient;
}

const DEFAULT_LIMIT = 50;

export class GraphFacade {
  constructor(private readonly deps: GraphFacadeDeps) {}

  async getCallers(req: GetCallersRequest): Promise<GetCallersResponse> {
    const edges = await this.deps.graphDb.getCallers(req.symbolId);
    return { callers: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async getCallees(req: GetCalleesRequest): Promise<GetCalleesResponse> {
    const edges = await this.deps.graphDb.getCallees(req.symbolId);
    return { callees: edges.slice(0, req.limit ?? DEFAULT_LIMIT) };
  }

  async findCycles(req: FindCyclesRequest): Promise<FindCyclesResponse> {
    const entries = await this.deps.graphDb.findCycles(req.scope);
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
