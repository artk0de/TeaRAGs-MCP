export { CONVENTION_PRIVACY_LANGUAGES, detectConventionPrivacyLeaks } from "./convention-privacy.js";
export { buildComponentGraph, COMPONENT_CONTAINMENT_REASON, COMPONENT_MODULE_STATUSES } from "./component-graph.js";
export {
  COMPONENT_EVIDENCE_FILE_EDGE_LIMIT,
  detectComponentStableDependencyViolations,
} from "./component-stable-dependencies.js";
export { classifyDirectoryRelation } from "./directory-relation.js";
export { FACADE_AGGREGATION_REASON, isFacadeAggregationEdge } from "./facade-aggregation.js";
export { computeFileInstabilities } from "./file-instability.js";
export {
  detectLeakingAbstractions,
  FACADE_ADOPTION_MAJORITY,
  FACADE_MIN_EXTERNAL_IMPORTERS,
  FACADE_MODULE_EXCLUSION_REASONS,
  FACADE_OTSU_MIN_POPULATION,
  MODULE_ENTRY_FILE_NAMES,
  resolveFacadeAdoptionThreshold,
  type FacadeAdoptionThresholdPolicy,
} from "./leaking-abstraction.js";
export {
  otsuSplit,
  resolveMajorityFlooredOtsuThreshold,
  type MajorityFlooredOtsuOptions,
  type MajorityFlooredOtsuThreshold,
  type OtsuSplit,
} from "./otsu-split.js";
export {
  excludeNonProductionFiles,
  NON_PRODUCTION_REASON,
  type ProductionDependencyGraph,
} from "./production-graph.js";
export {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
  NO_SYMBOL_ENDPOINT_REASON,
  PRIVATE_COLLABORATOR_REASON,
} from "./stable-dependencies.js";
export type {
  ArchitectureComponent,
  ArchitectureComponentKind,
  ComponentDependency,
  ComponentDependencyFileEdge,
  ComponentGraph,
  ComponentGraphExclusionCounts,
  ComponentStableDependenciesExclusionCounts,
  ComponentStableDependenciesOptions,
  ComponentStableDependenciesReport,
  ComponentStableDependenciesSummary,
  ComponentStableDependencyRootCause,
  ComponentStableDependencyViolation,
  ConventionPrivacyOptions,
  ConventionPrivacyReport,
  ConventionPrivacyRule,
  ConventionPrivacySummary,
  ConventionPrivacyViolation,
  DependencyDirectoryRelation,
  FacadeAdoption,
  FacadeLeakKind,
  FacadeLeakRootCause,
  FacadeLeakViolation,
  FacadeModuleAssessment,
  FacadeModuleExclusionReason,
  FacadeModuleStatus,
  LeakingAbstractionOptions,
  LeakingAbstractionReport,
  LeakingAbstractionSummary,
  NoSymbolEndpointFile,
  StableDependenciesExclusionCounts,
  StableDependenciesOptions,
  StableDependenciesReport,
  StableDependenciesScope,
  StableDependenciesSummary,
  StableDependencyRootCause,
  StableDependencyViolation,
} from "./types.js";
