export { classifyDirectoryRelation } from "./directory-relation.js";
export { computeFileInstabilities } from "./file-instability.js";
export {
  DEFAULT_SDP_MIN_CONNECTION_COUNT,
  DEFAULT_SDP_TOLERANCE,
  detectStableDependencyViolations,
  NO_SYMBOL_ENDPOINT_REASON,
} from "./stable-dependencies.js";
export type {
  DependencyDirectoryRelation,
  NoSymbolEndpointFile,
  StableDependenciesExclusionCounts,
  StableDependenciesOptions,
  StableDependenciesReport,
  StableDependenciesSummary,
  StableDependencyViolation,
} from "./types.js";
