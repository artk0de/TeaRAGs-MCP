import type {
  CodegraphResidualEdgeStore,
  ModelEdgeApplyResult,
  ModelEdgeRow,
  ModelExternalSiteRow,
  ModelResolvedSiteCount,
  ResidualCallSiteRow,
  StaticSiteSampleRow,
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

  async readStaticSiteSample(): Promise<StaticSiteSampleRow[]> {
    return (await this.ops.call("readStaticSiteSample", {})) as StaticSiteSampleRow[];
  }

  async applyModelEdges(model: string, edges: ModelEdgeRow[]): Promise<ModelEdgeApplyResult> {
    return (await this.ops.call("applyModelEdges", { model, edges })) as ModelEdgeApplyResult;
  }

  async applyModelExternalSites(model: string, sites: ModelExternalSiteRow[]): Promise<void> {
    await this.ops.call("applyModelExternalSites", { model, sites });
  }

  async getModelResolvedSiteCounts(thresholds: Readonly<Record<string, number>>): Promise<ModelResolvedSiteCount[]> {
    return (await this.ops.call("getModelResolvedSiteCounts", { thresholds })) as ModelResolvedSiteCount[];
  }
}
