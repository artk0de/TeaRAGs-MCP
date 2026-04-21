/**
 * Collection-stats accumulator contract.
 *
 * Trajectories contribute accumulators via `Trajectory.statsAccumulators`.
 * Ingest orchestrates them over scrolled Qdrant points — each accumulator
 * owns its mutable state and reads only the payload fields it understands.
 *
 * Ingest layer MUST NOT import trajectory-specific payload keys (e.g.
 * `git.file.dominantAuthor`). Only the owning trajectory accumulator reads
 * them. This preserves the `ingest -/-> trajectory` layering rule.
 */

export interface StatsPoint {
  payload: Record<string, unknown>;
}

/**
 * Per-point derived context, computed once by the orchestrator and passed
 * to every accumulator. Avoids re-parsing payload N times per point.
 */
export interface PointContext {
  pointChunkType: string | undefined;
  lang: string | undefined;
  isCodeLanguage: boolean;
  relPath: string;
  /** null when scope cannot be determined (non-code language, no relPath). */
  scope: "source" | "test" | null;
}

export interface StatsAccumulator<R = unknown> {
  accept: (point: StatsPoint, ctx: PointContext) => void;
  result: () => R;
}

export type StatsAccumulatorFactory<R = unknown> = () => StatsAccumulator<R>;

export interface StatsAccumulatorDescriptor<R = unknown> {
  readonly key: string;
  readonly factory: StatsAccumulatorFactory<R>;
}

/**
 * Well-known accumulator keys — shared vocabulary between trajectories
 * (which produce) and ingest (which consumes into ExtractedValues).
 *
 * Trajectories own WHAT is read (payload paths) and HOW it's aggregated.
 * Keys just name the slots so ingest can assemble results without knowing
 * trajectory internals.
 */
export const STATS_ACCUMULATOR_KEYS = {
  // Static (structural) — populated by domains/trajectory/static/stats/
  LANGUAGE_COUNTS: "languageCounts",
  CHUNK_TYPE_COUNTS: "chunkTypeCounts",
  DOCS_CODE_COUNTS: "docsCodeCounts",
  DISTINCT_PATHS: "distinctPaths",
  // Git — populated by domains/trajectory/git/stats/
  AUTHOR_COUNTS: "authorCounts",
  FILE_TIME_RANGE: "fileTimeRange",
  CHUNK_TIME_RANGE: "chunkTimeRange",
  GIT_DATA_PATHS: "gitDataPaths",
  // Built-in (ingest-local, parameterized by PayloadSignalDescriptor[])
  SIGNAL_VALUES: "signalValues",
} as const;

export type StatsAccumulatorKey = (typeof STATS_ACCUMULATOR_KEYS)[keyof typeof STATS_ACCUMULATOR_KEYS];
