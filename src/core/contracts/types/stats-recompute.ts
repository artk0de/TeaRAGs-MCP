/**
 * Port for the lazy percentile backfill the Reranker triggers on cold start.
 *
 * Implemented by ingest's `StatsRecomputeService`; explore's `Reranker`
 * receives it through `setRecomputeService`, so the read path depends on this
 * contract instead of on the ingest implementation.
 */

import type { CollectionSignalStats, PayloadSignalDescriptor } from "./trajectory.js";

export interface StatsRecomputeServicePort {
  /**
   * Cold-start coverage check. Idempotent and side-effect-free when no
   * descriptor references a percentile missing from stats; otherwise fills the
   * gaps in `stats` in place and persists them.
   */
  ensureCoverage: (
    collectionName: string,
    stats: CollectionSignalStats,
    payloadSignals: PayloadSignalDescriptor[],
    payloadFieldKeys?: string[],
  ) => Promise<void>;
}
