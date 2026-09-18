export { classifyDirectoryRelation } from "./directory-relation.js";
export { computeFileInstabilities } from "./file-instability.js";
export {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
} from "./stable-dependencies.js";
export type {
  DependencyDirectoryRelation,
  StableDependenciesExclusionCounts,
  StableDependenciesOptions,
  StableDependenciesReport,
  StableDependenciesSummary,
  StableDependencyViolation,
} from "./types.js";
