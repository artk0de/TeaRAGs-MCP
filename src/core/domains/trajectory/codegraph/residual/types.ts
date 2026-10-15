/**
 * Residual resolution port, domain side. The port types are declared in
 * contracts because adapters (`ResidualVerdictStore`, `KevResidualProvider`)
 * may import only `core/{contracts,infra}`; domain code reads them through this
 * re-export.
 */

export type {
  ResidualAnswer,
  ResidualDerivedState,
  ResidualModelProvider,
  ResidualPassDurations,
  ResidualPassMode,
  ResidualPassReport,
  ResidualProviderLease,
  ResidualQuestion,
  ResidualQuestionGroup,
  ResidualVerdict,
} from "../../../../contracts/types/codegraph-residual.js";
