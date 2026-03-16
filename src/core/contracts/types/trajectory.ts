/**
 * Trajectory type system — payload signal descriptors, stats, and extraction context.
 */

import type { EnrichmentProvider, FilterDescriptor } from "./provider.js";
import type { DerivedSignalDescriptor, RerankPreset, SignalLevel } from "./reranker.js";

/** What statistics to compute for this signal at collection level. */
export interface SignalStatsRequest {
  /**
   * Percentile-to-label mapping. Keys are pNN (e.g. p25, p50, p75, p95).
   * Percentiles to collect are derived from keys.
   * Labels are used in ranking overlay and get_index_metrics labelMap.
   */
  labels?: Record<string, string>;
  /** Compute arithmetic mean */
  mean?: boolean;
  /** Compute standard deviation */
  stddev?: boolean;
}

/** Raw Qdrant payload field descriptor — key + type + description. */
export interface PayloadSignalDescriptor {
  /** Full Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description */
  description: string;
  /** Optional: declare what collection-level stats to compute for this signal */
  stats?: SignalStatsRequest;
  /** Include in metaOnly results even without overlay mask. Default: false. */
  essential?: boolean;
}

/** Computed statistics for a single signal across the collection. */
export interface SignalStats {
  count: number;
  /** Keyed by percentile number: { 25: 4.2, 50: 8.1, 75: 15.3, 95: 42.0 } */
  percentiles?: Record<number, number>;
  mean?: number;
  stddev?: number;
}

/** Collection-wide signal statistics, cached between reindexes. */
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  computedAt: number;
}

/** Context passed to DerivedSignalDescriptor.extract() for adaptive normalization. */
export interface ExtractContext {
  /** Per-source adaptive bounds keyed by source name (e.g. "file.ageDays" → 365) */
  bounds?: Record<string, number>;
  /** Confidence dampening threshold resolved by Reranker from collection stats. */
  dampeningThreshold?: number;
  /** Collection-level signal statistics for signals needing specific percentiles (p50, p25, etc.) */
  collectionStats?: CollectionSignalStats;
  /** Signal level from preset — when "file", forces alpha=0 (pure file signals). */
  signalLevel?: SignalLevel;
}

/**
 * Declares which collection-level statistic to use as confidence dampening threshold.
 * Each trajectory provides its own dampening config (e.g., git uses commitCount p25).
 */
export interface DampeningConfig {
  /** Full Qdrant payload key (e.g. "git.file.commitCount") */
  readonly key: string;
  /** Which percentile to use as threshold (e.g. 25) */
  readonly percentile: number;
}

/**
 * Trajectory — unified entry point for a trajectory module.
 *
 * Aggregates all query-side (signals, reranking, filters, presets)
 * and ingest-side (enrichment provider) capabilities under a single key.
 */
export interface Trajectory {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  // Query-side
  readonly payloadSignals: PayloadSignalDescriptor[];
  readonly derivedSignals: DerivedSignalDescriptor[];
  readonly filters: FilterDescriptor[];
  readonly presets: RerankPreset[];
  // Ingest-side (ISP) — optional: not all trajectories have ingest enrichment
  readonly enrichment?: EnrichmentProvider;
}
