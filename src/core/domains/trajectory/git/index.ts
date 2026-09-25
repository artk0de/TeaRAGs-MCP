export { TrajectoryGitError, GitBlameFailedError, GitLogTimeoutError, GitNotAvailableError } from "./errors.js";
export { GitEnrichmentProvider, type GitProviderConfig } from "./provider.js";
export { createGitEnrichmentProvider, type GitWorkerConfig } from "./factory.js";
export { gitFilters } from "./filters.js";
export { gitPayloadSignalDescriptors } from "./payload-signals.js";
export {
  AGE_DERIVATION,
  AGE_STAMP_FIELD,
  DAY_SECONDS,
  LAST_MODIFIED_FIELD,
  ageDaysFromStamp,
  ageFloorDaysFromStamp,
  invertPercentile,
  invertPercentileKey,
  labelThresholdsFromStamps,
  stampThresholdFromDays,
  stampToTimestampKey,
} from "./age-derivation.js";
export type { GitFileSignals, ChunkChurnOverlay } from "./types.js";
// Repo-wide history reads shared with the codegraph temporal sub-graph
// (bd tea-rags-mcp-x4rpp): the run-scoped discovery matrix and its store, the
// rename-following and merge rules, and the ONE author-session grouping rule.
export {
  GitCommitDiscovery,
  type GitCommitDiscoveryEntry,
  type GitCommitDiscoveryOptions,
} from "./infra/commit-discovery.js";
export { GitCommitDiscoveryStore } from "./infra/commit-discovery-store.js";
export { resolveHeadPaths } from "./infra/rename-following.js";
export { MERGE_SUBJECT } from "./infra/utils.js";
export { partitionIntoAuthorSessions } from "./infra/metrics/sessions.js";
