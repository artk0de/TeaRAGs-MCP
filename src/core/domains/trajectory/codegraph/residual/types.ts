/**
 * Residual resolution port, domain side. The port types are declared in
 * contracts because adapters (`ResidualVerdictStore`, `KevResidualProvider`)
 * may import only `core/{contracts,infra}`; domain code reads them through this
 * re-export. `ResidualPassReport` is domain-only.
 */

export type {
  ResidualAnswer,
  ResidualModelProvider,
  ResidualQuestion,
  ResidualQuestionGroup,
  ResidualVerdict,
} from "../../../../contracts/types/codegraph-residual.js";

export interface ResidualPassReport {
  status: "completed" | "skipped";
  reason?: string;
  sites: number;
  reused: number;
  asked: number;
  applied: number;
  overflowSkipped: number;
}
