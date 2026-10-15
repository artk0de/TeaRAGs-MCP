import type {
  CodegraphResidualEdgeStore,
  ModelEdgeRow,
  ResidualCallSiteRow,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/**
 * `CodegraphResidualEdgeStore` over the daemon socket (residual call sites and
 * model edges, bd tea-rags-mcp-2m83f).
 */
export class DaemonResidualEdgeStoreProxy implements CodegraphResidualEdgeStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async readResidualCallSites(): Promise<ResidualCallSiteRow[]> {
    return (await this.ops.call("readResidualCallSites", {})) as ResidualCallSiteRow[];
  }

  async applyModelEdges(model: string, edges: ModelEdgeRow[]): Promise<void> {
    await this.ops.call("applyModelEdges", { model, edges });
  }
}
