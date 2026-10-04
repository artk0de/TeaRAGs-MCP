export { TrajectoryGitError, GitBlameFailedError, GitLogTimeoutError, GitNotAvailableError } from "./errors.js";
export { GitEnrichmentProvider, gitEnrichmentScope, type GitProviderConfig } from "./provider.js";
export { createGitEnrichmentProvider, type GitWorkerConfig } from "./factory.js";
export { gitFilters } from "./filters.js";
export { GIT_FILTER_PRESETS } from "./filter-presets/index.js";
export { gitPayloadSignalDescriptors } from "./payload-signals.js";
export { gitDerivedSignals } from "./rerank/derived-signals/index.js";
export { GIT_PRESETS } from "./rerank/presets/index.js";
export { gitStatsAccumulators } from "./stats/index.js";
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
// Query-time `git.file` / `git.chunk` for working-tree delta rows no base point
// answers (bd tea-rags-mcp-xi2r9, D12) — ingest's own computation, no run state.
export {
  buildOnDemandGitSignals,
  gitFileSignalsAtLineCount,
  type OnDemandGitChunkTarget,
  type OnDemandGitSignalOptions,
  type OnDemandGitSignals,
  type OnDemandGitSignalTarget,
} from "./infra/on-demand-signals.js";
export type { SquashOptions } from "./infra/metrics.js";
// The query-time half of TRAJECTORY_GIT_ANCHOR (bd tea-rags-mcp-zwu7m): the
// clock a read measures stored ages from, taken from the index's stamped mode.
export {
  HISTORY_ANCHOR_ENV_KEY,
  resolveIndexHistoryAnchorSec,
  stampedHistoryAnchorMode,
  type GitHistoryAnchorMode,
} from "./infra/history-anchor.js";
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
