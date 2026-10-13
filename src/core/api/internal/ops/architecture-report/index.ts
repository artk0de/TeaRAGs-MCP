/**
 * The architecture report's per-detector-family mappers (bd tea-rags-mcp-u4920):
 * each file holds one family's summariser, root-cause and violation mappers,
 * so a detector's presentation changes in one place.
 * `ArchitectureReportOps` keeps the detector runs and the response shaping and
 * reaches these only through this barrel.
 */

export { compareCodePoints, round3 } from "./architecture-report-value-format.js";
export { changeReasonsView } from "./change-reasons-view.js";
export { normsDto, normsViolations } from "./dependency-norms-findings.js";
export { hubLikeDependencyViolations, summariseHubLikeDependency } from "./hub-like-dependency-findings.js";
export {
  LAYERING_FEEDBACK_EDGE_LIMIT,
  LAYERING_KNOT_MEMBER_LIMIT,
  LAYERING_NESTED_PAIR_LIMIT,
  summariseLayering,
  toLayeringArchitectureViolation,
} from "./layering-findings.js";
export {
  buildArchitectureKnotMembership,
  findingsInKnot,
  knotView,
  type ArchitectureDetectorReports,
  type ArchitectureKnotMembership,
} from "./layering-knot-view.js";
export { leakRootCauses, leakViolations, summariseLeaks } from "./leaking-abstraction-findings.js";
export { mainSequenceViolations, summariseMainSequence } from "./main-sequence-findings.js";
export { summarisePropagationCost } from "./propagation-cost-findings.js";
export {
  isDocumentationPath,
  silentCouplingArchitectureViolations,
  silentRootCauses,
  silentViolations,
  summariseSilentCoupling,
  summariseSplitMerge,
} from "./silent-coupling-findings.js";
export {
  sdpRootCauses,
  sdpViolations,
  STABLE_DEPENDENCIES_EXCLUSION_REASONS,
  summariseStableDependencies,
} from "./stable-dependencies-findings.js";
