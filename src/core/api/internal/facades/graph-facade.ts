/**
 * GraphFacade — thin orchestrator over `GraphDbClient` for the two MCP
 * graph tools (`get_callers`, `get_callees`).
 *
 * Per `.claude/rules/facade-discipline.md` the facade only validates
 * input and delegates. The body is intentionally tiny — when result
 * shaping grows past 20 lines (e.g. attaching `ChunkPreview` payloads
 * from `find_symbol`), extract a `GraphOps` class. Slice 1's reads are
 * direct edge reads so the facade itself is enough.
 */

import type { GraphDbClient } from "../../../contracts/types/codegraph.js";
import type {
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
}
