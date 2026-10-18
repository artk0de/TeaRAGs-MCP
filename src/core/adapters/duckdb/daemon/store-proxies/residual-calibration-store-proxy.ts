import type {
  CodegraphResidualCalibrationStore,
  ResidualCalibrationRow,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/** `CodegraphResidualCalibrationStore` over the daemon socket (bd tea-rags-mcp-2m83f.62). */
export class DaemonResidualCalibrationStoreProxy implements CodegraphResidualCalibrationStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async readResidualCalibration(language: string): Promise<ResidualCalibrationRow[]> {
    return (await this.ops.call("readResidualCalibration", { language })) as ResidualCalibrationRow[];
  }

  async writeResidualCalibration(language: string, rows: ResidualCalibrationRow[]): Promise<void> {
    await this.ops.call("writeResidualCalibration", { language, rows });
  }
}
