/**
 * Trajectory type system — payload signal descriptors, stats, and extraction context.
 */

/** Raw Qdrant payload field descriptor — key + type + description. */
export interface PayloadSignalDescriptor {
  /** Full Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description */
  description: string;
}

/** Percentile distribution for a single numeric signal across the collection. */
export interface SignalStats {
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  count: number;
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
