/**
 * Trajectory type system — payload signal descriptors, stats, and extraction context.
 */

import type { EnrichmentProvider, FilterDescriptor } from "./provider.js";
import type { DerivedSignalDescriptor, RerankPreset } from "./reranker.js";

/** What statistics to compute for this signal at collection level. */
export interface SignalStatsRequest {
  /** Which percentiles to compute (e.g. [25, 50, 75, 95]) */
  percentiles?: number[];
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
  /** Adaptive bound from result batch (p95, floored with defaultBound) */
  bound?: number;
  /** Collection-wide signal stats (cached until reindex) */
  collectionStats?: CollectionSignalStats;
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
  // Ingest-side (ISP)
  readonly enrichment: EnrichmentProvider;
}
