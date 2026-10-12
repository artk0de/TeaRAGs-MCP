export { cleanupOrphanedVersions } from "./alias-cleanup.js";
export { isCollectionIndexingInFlight } from "./collection-build-lease.js";
export {
  CollectionIndexingLock,
  HeldCollectionIndexingLock,
  type CollectionIndexingLockOptions,
  type IndexingLockLivenessProbe,
  type IndexingLockRecord,
} from "./collection-indexing-lock.js";
export type { CollectionIndexingLockPort, HeldCollectionIndexingLockPort, IndexingLockLiveness } from "./ports.js";
export {
  ENRICHMENT_STALE_THRESHOLD_MS,
  ENRICHMENT_TERMINAL_STATUSES,
  getNestedMarker,
  isEnrichmentRunLive,
  type ChunkEnrichmentMarker,
  type EnrichmentLevelMarker,
  type EnrichmentLevelRecord,
  type EnrichmentLevelStatus,
  type EnrichmentMarkerMap,
  type FileEnrichmentMarker,
  type ProviderEnrichmentMarker,
  type RunMarker,
} from "./enrichment-run-liveness.js";
export {
  INDEXING_HEARTBEAT_INTERVAL_MS,
  indexingRunHeartbeatAt,
  isIndexingRunStale,
  parseMarkerPayload,
  STALE_INDEXING_THRESHOLD_MS,
  type IndexingMarkerPayload,
  type WorktreeSeedPending,
} from "./indexing-marker-codec.js";
export { computeCollectionStats, MIN_LANGUAGE_SHARE, validateSignalDependencies } from "./collection-stats.js";
export { HeartbeatGuard, type HeartbeatOptions } from "./heartbeat-guard.js";
export { OptimizerLifecycle } from "./optimizer-lifecycle.js";
export { StatsRecomputeService } from "./stats-recompute.js";
