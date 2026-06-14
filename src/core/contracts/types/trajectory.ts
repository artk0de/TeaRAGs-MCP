/**
 * Trajectory type system — payload signal descriptors, stats, and extraction context.
 */

import type { EnrichmentProvider, FilterDescriptor, FilterLevel } from "./provider.js";
import type { DerivedSignalDescriptor, RerankPreset, SignalLevel } from "./reranker.js";
import type { StatsAccumulatorDescriptor } from "./stats-accumulator.js";

/**
 * Narrow capability contract for explore-side filter construction. The full
 * `TrajectoryRegistry` class in `domains/trajectory/` structurally implements
 * this interface; explore strategies receive it as a DI parameter typed against
 * the contract, never the concrete registry — that keeps the domain boundary
 * (`explore` does not import `trajectory`).
 */
export interface TrajectoryFilterBuilder {
  buildMergedFilter: (
    typedParams: Record<string, unknown>,
    rawFilter?: Record<string, unknown>,
    level?: FilterLevel,
  ) => Record<string, unknown> | undefined;
}

/** What statistics to compute for this signal at collection level. */
export interface SignalStatsRequest {
  /**
   * Percentile-to-label mapping. Keys are pNN (e.g. p25, p50, p75, p95).
   * Percentiles to collect are derived from keys.
   * Labels are used in ranking overlay and get_index_metrics labelMap.
   */
  labels?: Record<string, string>;
  /**
   * Extra percentiles to compute at index time beyond those declared via
   * `labels` keys. Required when OTHER descriptors reference this signal via
   * `confidence.support` and need percentiles not part of this signal's own
   * labelMap. Example: `git.file.commitCount` declares p25/p50/p75/p95 in
   * labels but must add p10 here because `bugFixRate.confidence` references
   * "p10" of commitCount as a label clamp threshold.
   *
   * Validation: `validateSignalDependencies` (collection-stats.ts) throws at
   * descriptor-load time if any signal references a percentile that's not
   * declared in EITHER labels keys OR percentilesToCompute on the support.
   */
  percentilesToCompute?: number[];
  /**
   * Optional confidence declaration — when this signal is a ratio or aggregate
   * whose reliability depends on a sibling support signal (e.g. bugFixRate
   * depends on commitCount), declare the support + how score-side dampening
   * and label-side clamp consume it. See SignalConfidence for shape.
   */
  confidence?: SignalConfidence;
  /** Compute arithmetic mean */
  mean?: boolean;
  /** Compute standard deviation */
  stddev?: boolean;
  /** Only include points where payload.chunkType matches this value. */
  chunkTypeFilter?: string;
}

/**
 * One label-clamp rule: when the support sibling's value is below
 * `whenSupportBelow`, the signal's overlay label is capped at `ceiling`.
 * `ceiling` MUST be one of the values in the descriptor's `labels` map;
 * runtime resolver enforces this and throws on misconfiguration.
 *
 * `whenSupportBelow` accepts two forms:
 *   • `number` — static threshold, used as-is.
 *   • `"pN"` — adaptive percentile of the SUPPORT signal (e.g. "p25" reads
 *     p25 of `git.{scope}.{confidence.support}` from collection stats).
 *     Reranker pre-resolves the string to a number before applying.
 *
 * `fallback` is the static threshold used when `whenSupportBelow` is a
 * percentile string AND collection stats are unavailable (or the support
 * signal has no recorded percentile). Required when `whenSupportBelow` is
 * a string; ignored when it's a number.
 */
export interface ConfidenceClampRule {
  whenSupportBelow: number | `p${number}`;
  fallback?: number;
  ceiling: string;
}

/**
 * Unified confidence declaration for a raw payload signal.
 *
 * Lives on `PayloadSignalDescriptor.stats.confidence`. Drives two consumers
 * that share one source of truth:
 * 1. Score-side: `confidenceDampening(supportValue, score.threshold)` in
 *    derived-signal extraction. Replaces per-signal-class `dampeningSource` +
 *    `FALLBACK_THRESHOLD` constants.
 * 2. Label-side: walks `label.rules` to cap overlay labels at low-support
 *    bins. Raw value is preserved; only the bin shifts.
 *
 * `support` is a bare sibling signal name resolved at the SAME scope as the
 * signal being labeled — file-scope descriptors read file-scope siblings,
 * chunk-scope read chunk-scope. Cross-scope reads are out of scope.
 */
export interface SignalConfidence {
  /** Bare sibling name (e.g. "commitCount"). Same-scope resolution only. */
  support: string;
  /**
   * Optional continuous dampening parameters for score path.
   *   • `threshold` — STATIC floor used when collection stats are unavailable
   *     OR when `adaptivePercentile` is not declared.
   *   • `adaptivePercentile` — percentile of the support sibling read from
   *     collection stats as the adaptive `k` for `confidenceDampening`. When
   *     declared, reranker passes the resolved adaptive value via
   *     `ExtractContext.dampeningThreshold`. Default behavior in the reranker
   *     (when this field is absent) is to look up p25 for backwards
   *     compatibility with the legacy `GIT_FILE_DAMPENING` convention.
   */
  score?: { threshold: number; adaptivePercentile?: number };
  /** Optional categorical clamp rules for label path. */
  label?: { rules: ConfidenceClampRule[] };
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
  min: number;
  max: number;
  /** Keyed by percentile number: { 25: 4.2, 50: 8.1, 75: 15.3, 95: 42.0 } */
  percentiles: Record<number, number>;
  mean?: number;
  stddev?: number;
}

/** Signal stats split by scope (source code vs test code). */
export interface ScopedSignalStats {
  source: SignalStats;
  test?: SignalStats;
}

/** Time range covered by git enrichment data at a specific level. */
export interface LevelTimeRange {
  /** Earliest timestamp (file: firstCreatedAt, chunk: lastModifiedAt). */
  oldest: number;
  /** Latest lastModifiedAt timestamp. */
  newest: number;
  /** Configured time window for this level (months). */
  configTimePeriodMonths?: number;
}

/** Time range covered by git enrichment data, separated by signal level. */
export interface EnrichmentTimeRange {
  /** File-level: min firstCreatedAt → max lastModifiedAt. */
  file: LevelTimeRange;
  /** Chunk-level: min lastModifiedAt → max lastModifiedAt. */
  chunk?: LevelTimeRange;
  /** Number of distinct files that have git enrichment data. */
  filesWithGitData: number;
}

/** Distribution breakdowns across the collection. */
export interface Distributions {
  totalFiles: number;
  language: Record<string, number>;
  chunkType: Record<string, number>;
  documentation: { docs: number; code: number };
  /** Top dominant authors by commit-based attribution (recentDominantAuthor). */
  topAuthors: { name: string; chunks: number }[];
  /** Top dominant authors by line-based attribution (blameDominantAuthor from `git blame HEAD`). */
  topBlameAuthors: { name: string; chunks: number }[];
  othersCount: number;
  /** Time range of git enrichment data. Undefined when no git data present. */
  enrichmentTimeRange?: EnrichmentTimeRange;
}

/** Collection-wide signal statistics, cached between reindexes. */
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  /** Per-language signal stats, split by scope. Key = language name, value = signal → scoped stats. */
  perLanguage: Map<string, Map<string, ScopedSignalStats>>;
  distributions: Distributions;
  computedAt: number;
}

/** Context passed to DerivedSignalDescriptor.extract() for adaptive normalization. */
export interface ExtractContext {
  /** Per-source adaptive bounds keyed by source name (e.g. "file.ageDays" → 365) */
  bounds?: Record<string, number>;
  /**
   * Confidence dampening threshold for the FILE scope (k_f), resolved by Reranker
   * from `file.{support}` collection stats. File-only signals read just this.
   */
  dampeningThreshold?: number;
  /**
   * Confidence dampening threshold for the CHUNK scope (k_c), resolved by Reranker
   * from `chunk.{support}` collection stats. Blended signals dampen their chunk
   * component with this so a low-N chunk inside a high-commit file is not granted
   * the file's confidence (and vice versa). Absent for file-only signals.
   */
  dampeningThresholdChunk?: number;
  /**
   * Unified confidence declaration from the raw payload signal descriptor.
   * Derived signals that previously hardcoded `dampeningSource` and a static
   * `FALLBACK_THRESHOLD` SHOULD read parameters from here:
   * `ctx.confidence?.support` + `ctx.confidence?.score?.threshold`.
   * Populated by Reranker from the raw descriptor's `stats.confidence`.
   * Coexists with `dampeningThreshold` during migration — see
   * `.claude/rules/signal-confidence.md`.
   */
  confidence?: SignalConfidence;
  /** Collection-level signal statistics for signals needing specific percentiles (p50, p25, etc.) */
  collectionStats?: CollectionSignalStats;
  /** Signal level from preset — when "file", forces alpha=0 (pure file signals). */
  signalLevel?: SignalLevel;
  /** Search query text for query-dependent signals (e.g. heading relevance). */
  query?: string;
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
  // Collection-stats (ISP) — optional: accumulators the trajectory contributes
  // to computeCollectionStats. Reads payload fields only this trajectory owns.
  readonly statsAccumulators?: StatsAccumulatorDescriptor[];
  // Ingest-side (ISP) — optional: not all trajectories have ingest enrichment
  readonly enrichment?: EnrichmentProvider;
}
