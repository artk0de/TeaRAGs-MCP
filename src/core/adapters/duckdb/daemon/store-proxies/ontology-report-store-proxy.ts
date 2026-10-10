import type {
  CodegraphOntologyReportStore,
  OntologyReportQuery,
  OntologyReportSectionRows,
  OntologyReportSummaryRows,
} from "../../../../contracts/types/codegraph.js";
import type { DaemonOpCaller } from "../op-channel.js";

/** `CodegraphOntologyReportStore` over the daemon socket. */
export class DaemonOntologyReportStoreProxy implements CodegraphOntologyReportStore {
  constructor(private readonly ops: DaemonOpCaller) {}

  async readOntologyReportSummary(q: OntologyReportQuery): Promise<OntologyReportSummaryRows> {
    return (await this.ops.call("readOntologyReportSummary", { query: q })) as OntologyReportSummaryRows;
  }

  async readOntologyReportSections(
    q: OntologyReportQuery,
    excludedGenericNames: readonly string[],
  ): Promise<OntologyReportSectionRows> {
    return (await this.ops.call("readOntologyReportSections", {
      query: q,
      excludedGenericNames: [...excludedGenericNames],
    })) as OntologyReportSectionRows;
  }
}
