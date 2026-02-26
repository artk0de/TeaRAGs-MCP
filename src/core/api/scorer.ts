/**
 * Scorer interfaces for modular signal extraction.
 *
 * A Scorer is a pure function that extracts a single normalized (0-1) signal
 * from a search result payload. Scorers replace the monolithic calculateSignals
 * function with composable, testable, self-documenting units.
 *
 * CompositeScorer extends Scorer to combine multiple leaf scorers into
 * a derived signal (e.g., techDebt = age * 0.4 + churn * 0.6).
 */

/**
 * A single signal extractor.
 *
 * Each scorer produces one normalized value (0-1) from a search result payload.
 * The `name` must match the key used in ScoringWeights (e.g., "recency", "churn").
 */
export interface Scorer {
  /** Unique name matching the ScoringWeights key */
  readonly name: string;
  /** Human-readable description of what this signal measures */
  readonly description: string;
  /** Default normalization upper bound (e.g., 365 for ageDays) */
  readonly defaultBound?: number;
  /** Whether this signal needs confidence dampening for small sample sizes */
  readonly needsConfidence?: boolean;
  /** Payload field used to compute confidence (e.g., "commitCount") */
  readonly confidenceField?: string;
  /** Extract a normalized 0-1 value from a search result payload */
  extract: (payload: Record<string, unknown>) => number;
}

/**
 * A scorer that derives its value from other leaf scorers.
 *
 * Composites must declare their dependencies and bind to a scorer map
 * before extract() can produce meaningful results.
 */
export interface CompositeScorer extends Scorer {
  /** Names of leaf scorers this composite depends on */
  readonly dependencies: string[];
  /** Bind leaf scorers so extract() can delegate to them */
  bind: (scorers: Map<string, Scorer>) => void;
}
