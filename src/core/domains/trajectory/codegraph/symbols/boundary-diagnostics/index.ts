export { CONVENTION_PRIVACY_LANGUAGES, detectConventionPrivacyLeaks } from "./convention-privacy.js";
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
export { otsuSplit, type OtsuSplit } from "./otsu-split.js";
export {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
  NO_SYMBOL_ENDPOINT_REASON,
  PRIVATE_COLLABORATOR_REASON,
} from "./stable-dependencies.js";
export type {
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
