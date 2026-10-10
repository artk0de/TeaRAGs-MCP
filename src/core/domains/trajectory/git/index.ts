export { TrajectoryGitError, GitBlameFailedError, GitLogTimeoutError, GitNotAvailableError } from "./errors.js";
export { GitEnrichmentProvider, gitEnrichmentScope, type GitProviderConfig } from "./provider.js";
export { createGitEnrichmentProvider, type GitWorkerConfig } from "./factory.js";
export { gitFilters } from "./filters.js";
export { GIT_FILTER_PRESETS } from "./filter-presets/index.js";
export { gitPayloadSignalDescriptors } from "./payload-signals.js";
export { gitLineCountFormulas } from "./line-count-formulas.js";
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
  type OnDemandGitChunkTarget,
  type OnDemandGitSignalOptions,
  type OnDemandGitSignals,
  type OnDemandGitSignalTarget,
} from "./infra/on-demand-signals.js";
export { OnDemandHeadGitReadMemo } from "./infra/on-demand-head-git-reads.js";
export type { SquashOptions } from "./infra/metrics.js";
export { defaultBlamePoolSize } from "./infra/churn-walk/blame-pool-defaults.js";
// The query-time half of TRAJECTORY_GIT_ANCHOR (bd tea-rags-mcp-zwu7m): the
// clock a read measures stored ages from, taken from the index's stamped mode.
export {
  HISTORY_ANCHOR_ENV_KEY,
  resolveIndexHistoryAnchorSec,
  stampedHistoryAnchorMode,
  type GitHistoryAnchorMode,
} from "./history/index.js";
// Repo-wide history reads shared with the codegraph temporal sub-graph
// (bd tea-rags-mcp-x4rpp): the run-scoped discovery matrix and its store, the
// rename-following and merge rules, the ONE author-session grouping rule and
// the author identity it keys on (bd tea-rags-mcp-3vg0x bursts). Their home is
// the `history/` facade (bd tea-rags-mcp-89k7k.35.7); a consumer that needs only
// these imports that facade, not this module root.
export {
  GitCommitDiscovery,
  GitCommitDiscoveryStore,
  type GitCommitDiscoveryEntry,
  type GitCommitDiscoveryOptions,
  resolveHeadPaths,
  extractTaskIds,
  MERGE_SUBJECT,
  partitionIntoAuthorSessions,
  authorIdentityKey,
} from "./history/index.js";
