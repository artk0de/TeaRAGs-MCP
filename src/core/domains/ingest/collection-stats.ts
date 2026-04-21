/**
 * Generic collection-wide signal statistics computation.
 *
 * Receives already-fetched Qdrant points and PayloadSignalDescriptors,
 * computes statistics only for signals that declare a `stats` field.
 * Qdrant scrolling is handled at the API layer — this function is pure.
 */

import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../contracts/types/stats-accumulator.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  ScopedSignalStats,
  SignalStats,
} from "../../contracts/types/trajectory.js";
import { detectScope, type ScopeDetectionConfig } from "../../infra/scope-detection.js";
import { CODE_LANGUAGES } from "./pipeline/chunker/config.js";

const MIN_SAMPLE_SIZE = 10;
const MIN_LANGUAGE_SHARE = 0.05;

/**
 * Read a value from a nested object using dot-notation path.
 * Returns undefined if any segment is missing.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  // Try flat key first (Qdrant stores dot-notation paths as flat keys)
  if (path in payload) return payload[path];
  // Fall back to nested traversal
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Push a signal value to target array if the point passes chunkType filter
 * and the value is a positive number.
 */
function tryPushSignalValue(
  point: { payload: Record<string, unknown> },
  signal: PayloadSignalDescriptor,
  pointChunkType: unknown,
  target: number[],
): void {
  const filter = signal.stats?.chunkTypeFilter;
  if (filter && pointChunkType !== filter) return;
  const val = readPayloadPath(point.payload, signal.key);
  if (typeof val === "number" && val > 0) {
    target.push(val);
  }
}

/** Pre-pass: count test chunks per language for scope detection. */
function countTestChunksPerLanguage(points: StatsPoint[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const point of points) {
    if (point.payload["chunkType"] === "test" && typeof point.payload["language"] === "string") {
      const lang = point.payload["language"];
      counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  }
  return counts;
}

/** Derive per-point context once so all accumulators share the same parse. */
function derivePointContext(point: StatsPoint, scopeConfig: ScopeDetectionConfig): PointContext {
  const pointChunkType = typeof point.payload["chunkType"] === "string" ? point.payload["chunkType"] : undefined;
  const lang = typeof point.payload["language"] === "string" ? point.payload["language"] : undefined;
  const isCodeLanguage = lang !== undefined && CODE_LANGUAGES.has(lang);
  const relPath = typeof point.payload["relativePath"] === "string" ? point.payload["relativePath"] : "";
  const scope = isCodeLanguage && lang !== undefined ? detectScope(pointChunkType, relPath, lang, scopeConfig) : null;
  return { pointChunkType, lang, isCodeLanguage, relPath, scope };
}

interface SignalValuesResult {
  valueArrays: Map<string, number[]>;
  perLanguageValues: Map<string, Map<string, number[]>>;
  perLanguageScopedValues: Map<string, Map<string, { source: number[]; test: number[] }>>;
}

/**
 * Built-in ingest accumulator — parameterized by PayloadSignalDescriptor[].
 * Produces global + per-language + per-language-scoped signal value arrays.
 *
 * Lives in ingest (not a trajectory) because its aggregation shape depends
 * on the runtime-provided signals list, which is itself an aggregate of all
 * trajectories' payload signals.
 */
class SignalValuesAccumulator implements StatsAccumulator<SignalValuesResult> {
  private readonly valueArrays: Map<string, number[]>;
  private readonly perLanguageValues = new Map<string, Map<string, number[]>>();
  private readonly perLanguageScopedValues = new Map<string, Map<string, { source: number[]; test: number[] }>>();

  constructor(private readonly statsSignals: PayloadSignalDescriptor[]) {
    this.valueArrays = new Map(statsSignals.map((s) => [s.key, []]));
  }

  accept(point: StatsPoint, ctx: PointContext): void {
    if (ctx.isCodeLanguage && ctx.scope === "source") {
      for (const signal of this.statsSignals) {
        const arr = this.valueArrays.get(signal.key);
        if (arr) tryPushSignalValue(point, signal, ctx.pointChunkType, arr);
      }
    }
    if (typeof ctx.lang !== "string") return;

    let langMap = this.perLanguageValues.get(ctx.lang);
    if (!langMap) {
      langMap = new Map<string, number[]>();
      for (const signal of this.statsSignals) langMap.set(signal.key, []);
      this.perLanguageValues.set(ctx.lang, langMap);
    }
    for (const signal of this.statsSignals) {
      const langArr = langMap.get(signal.key);
      if (langArr) tryPushSignalValue(point, signal, ctx.pointChunkType, langArr);
    }

    if (ctx.scope === null) return;
    let scopedMap = this.perLanguageScopedValues.get(ctx.lang);
    if (!scopedMap) {
      scopedMap = new Map();
      for (const signal of this.statsSignals) scopedMap.set(signal.key, { source: [], test: [] });
      this.perLanguageScopedValues.set(ctx.lang, scopedMap);
    }
    for (const signal of this.statsSignals) {
      const scopedArr = scopedMap.get(signal.key);
      if (!scopedArr) continue;
      const target = ctx.scope === "test" ? scopedArr.test : scopedArr.source;
      tryPushSignalValue(point, signal, ctx.pointChunkType, target);
    }
  }

  result(): SignalValuesResult {
    return {
      valueArrays: this.valueArrays,
      perLanguageValues: this.perLanguageValues,
      perLanguageScopedValues: this.perLanguageScopedValues,
    };
  }
}

function signalValuesDescriptor(
  statsSignals: PayloadSignalDescriptor[],
): StatsAccumulatorDescriptor<SignalValuesResult> {
  return {
    key: STATS_ACCUMULATOR_KEYS.SIGNAL_VALUES,
    factory: () => new SignalValuesAccumulator(statsSignals),
  };
}

/**
 * Compute percentile from a sorted array using linear interpolation.
 *
 * For p in [0, 100], computes the index as (p/100) * (n-1),
 * then interpolates between the two adjacent values.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

interface ExtractedValues {
  valueArrays: Map<string, number[]>;
  languageCounts: Record<string, number>;
  chunkTypeCounts: Record<string, number>;
  docsCount: number;
  codeCount: number;
  distinctPaths: Set<string>;
  authorCounts: Map<string, number>;
  /** File-level: min firstCreatedAt */
  fileOldest: number | undefined;
  /** File-level: max lastModifiedAt */
  fileNewest: number | undefined;
  /** Chunk-level: min lastModifiedAt */
  chunkOldest: number | undefined;
  /** Chunk-level: max lastModifiedAt */
  chunkNewest: number | undefined;
  /** Distinct files that have git timestamp data */
  gitDataPaths: Set<string>;
  /** Per-language signal value arrays. Key = language, value = signal key → values. */
  perLanguageValues: Map<string, Map<string, number[]>>;
  /** Per-language scoped signal values: lang → signal → { source: number[], test: number[] }. */
  perLanguageScopedValues: Map<string, Map<string, { source: number[]; test: number[] }>>;
}

function extractSignalValues(
  points: StatsPoint[],
  statsSignals: PayloadSignalDescriptor[],
  trajectoryDescriptors: readonly StatsAccumulatorDescriptor[],
  scopeConfig?: ScopeDetectionConfig,
): ExtractedValues {
  const languageTestChunkCounts = countTestChunksPerLanguage(points);
  const effectiveScopeConfig: ScopeDetectionConfig = scopeConfig ?? { languageTestChunkCounts };

  const descriptors: StatsAccumulatorDescriptor[] = [signalValuesDescriptor(statsSignals), ...trajectoryDescriptors];
  const instances = new Map<string, StatsAccumulator>(descriptors.map((d) => [d.key, d.factory()]));

  for (const point of points) {
    const ctx = derivePointContext(point, effectiveScopeConfig);
    for (const acc of instances.values()) acc.accept(point, ctx);
  }

  const signalValuesAcc = instances.get(STATS_ACCUMULATOR_KEYS.SIGNAL_VALUES);
  if (!signalValuesAcc) throw new Error("SIGNAL_VALUES accumulator missing — orchestrator bug");
  const signalValues = signalValuesAcc.result() as SignalValuesResult;
  const languageCounts =
    (instances.get(STATS_ACCUMULATOR_KEYS.LANGUAGE_COUNTS)?.result() as Record<string, number>) ?? {};
  const chunkTypeCounts =
    (instances.get(STATS_ACCUMULATOR_KEYS.CHUNK_TYPE_COUNTS)?.result() as Record<string, number>) ?? {};
  const docsCode = (instances.get(STATS_ACCUMULATOR_KEYS.DOCS_CODE_COUNTS)?.result() as
    | { docsCount: number; codeCount: number }
    | undefined) ?? { docsCount: 0, codeCount: 0 };
  const distinctPaths =
    (instances.get(STATS_ACCUMULATOR_KEYS.DISTINCT_PATHS)?.result() as Set<string>) ?? new Set<string>();
  const authorCounts =
    (instances.get(STATS_ACCUMULATOR_KEYS.AUTHOR_COUNTS)?.result() as Map<string, number>) ?? new Map<string, number>();
  const fileRange = (instances.get(STATS_ACCUMULATOR_KEYS.FILE_TIME_RANGE)?.result() as
    | { fileOldest: number | undefined; fileNewest: number | undefined }
    | undefined) ?? { fileOldest: undefined, fileNewest: undefined };
  const chunkRange = (instances.get(STATS_ACCUMULATOR_KEYS.CHUNK_TIME_RANGE)?.result() as
    | { chunkOldest: number | undefined; chunkNewest: number | undefined }
    | undefined) ?? { chunkOldest: undefined, chunkNewest: undefined };
  const gitDataPaths =
    (instances.get(STATS_ACCUMULATOR_KEYS.GIT_DATA_PATHS)?.result() as Set<string>) ?? new Set<string>();

  return {
    valueArrays: signalValues.valueArrays,
    languageCounts,
    chunkTypeCounts,
    docsCount: docsCode.docsCount,
    codeCount: docsCode.codeCount,
    distinctPaths,
    authorCounts,
    fileOldest: fileRange.fileOldest,
    fileNewest: fileRange.fileNewest,
    chunkOldest: chunkRange.chunkOldest,
    chunkNewest: chunkRange.chunkNewest,
    gitDataPaths,
    perLanguageValues: signalValues.perLanguageValues,
    perLanguageScopedValues: signalValues.perLanguageScopedValues,
  };
}

function computePerSignalStats(
  valueArrays: Map<string, number[]>,
  statsSignals: PayloadSignalDescriptor[],
): Map<string, SignalStats> {
  const perSignal = new Map<string, SignalStats>();
  for (const signal of statsSignals) {
    const values = valueArrays.get(signal.key);
    if (!values || values.length === 0) continue;
    values.sort((a, b) => a - b);

    const req = signal.stats;
    if (!req) continue;

    const result: SignalStats = {
      count: values.length,
      min: values[0],
      max: values[values.length - 1],
      percentiles: {},
    };

    if (req.labels && Object.keys(req.labels).length > 0) {
      for (const key of Object.keys(req.labels)) {
        const p = parseInt(key.slice(1), 10);
        if (!isNaN(p)) {
          result.percentiles[p] = percentile(values, p);
        }
      }
    }

    if (req.mean) {
      const sum = values.reduce((a, b) => a + b, 0);
      result.mean = sum / values.length;
    }

    if (req.stddev) {
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
      result.stddev = Math.sqrt(variance);
    }

    perSignal.set(signal.key, result);
  }
  return perSignal;
}

function buildDistributions(
  extracted: ExtractedValues,
  gitTimePeriods?: { fileMonths: number; chunkMonths: number },
): CollectionSignalStats["distributions"] {
  const sortedAuthors = Array.from(extracted.authorCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topAuthors = sortedAuthors.slice(0, 10).map(([name, chunks]) => ({ name, chunks }));
  const othersCount = sortedAuthors.slice(10).reduce((sum, [, chunks]) => sum + chunks, 0);

  const hasFileRange = extracted.fileOldest !== undefined && extracted.fileNewest !== undefined;
  const enrichmentTimeRange = hasFileRange
    ? {
        file: {
          oldest: extracted.fileOldest as number,
          newest: extracted.fileNewest as number,
          configTimePeriodMonths: gitTimePeriods?.fileMonths,
        },
        chunk:
          extracted.chunkOldest !== undefined && extracted.chunkNewest !== undefined
            ? {
                oldest: extracted.chunkOldest,
                newest: extracted.chunkNewest,
                configTimePeriodMonths: gitTimePeriods?.chunkMonths,
              }
            : undefined,
        filesWithGitData: extracted.gitDataPaths.size,
      }
    : undefined;

  return {
    totalFiles: extracted.distinctPaths.size,
    language: extracted.languageCounts,
    chunkType: extracted.chunkTypeCounts,
    documentation: { docs: extracted.docsCount, code: extracted.codeCount },
    topAuthors,
    othersCount,
    enrichmentTimeRange,
  };
}

/**
 * Compute collection-wide stats for PayloadSignalDescriptors that declare a `stats` field.
 *
 * - Filters to signals WITH `stats` request (not just numeric type)
 * - Resolves dot-notation paths against each point's payload
 * - Skips missing/non-numeric/zero-or-negative values
 * - Computes only what's declared: percentiles, mean, stddev
 * - Returns empty perSignal map for signals with no valid values
 */
export function computeCollectionStats(
  points: StatsPoint[],
  signals: PayloadSignalDescriptor[],
  trajectoryAccumulators: readonly StatsAccumulatorDescriptor[],
  gitTimePeriods?: { fileMonths: number; chunkMonths: number },
): CollectionSignalStats {
  const statsSignals = signals.filter((s) => s.stats !== undefined);
  const extracted = extractSignalValues(points, statsSignals, trajectoryAccumulators);
  const perSignal = computePerSignalStats(extracted.valueArrays, statsSignals);
  const distributions = buildDistributions(extracted, gitTimePeriods);

  const totalChunks = points.length;
  const perLanguage = new Map<string, Map<string, ScopedSignalStats>>();

  for (const [lang, langValueArrays] of extracted.perLanguageValues) {
    // Only code languages with AST support qualify
    if (!CODE_LANGUAGES.has(lang)) continue;

    // Must represent >= 5% of project chunks
    const langCount = extracted.languageCounts[lang] ?? 0;
    if (totalChunks > 0 && langCount / totalChunks < MIN_LANGUAGE_SHARE) continue;

    const hasEnoughSamples = statsSignals.some((s) => {
      const values = langValueArrays.get(s.key);
      return values !== undefined && values.length >= MIN_SAMPLE_SIZE;
    });
    if (!hasEnoughSamples) continue;

    // Build scoped stats from perLanguageScopedValues
    const scopedMap = extracted.perLanguageScopedValues.get(lang);
    if (!scopedMap) continue;

    const scopedStats = new Map<string, ScopedSignalStats>();
    for (const [key, { source: sourceValues, test: testValues }] of scopedMap) {
      const sourceArr = new Map<string, number[]>([[key, sourceValues]]);
      const sourceStats = computePerSignalStats(sourceArr, statsSignals).get(key);
      if (!sourceStats) continue;

      const testArr = new Map<string, number[]>([[key, testValues]]);
      const testStats = testValues.length > 0 ? computePerSignalStats(testArr, statsSignals).get(key) : undefined;

      scopedStats.set(key, { source: sourceStats, test: testStats });
    }

    if (scopedStats.size > 0) {
      perLanguage.set(lang, scopedStats);
    }
  }

  return {
    perSignal,
    perLanguage,
    distributions,
    computedAt: Date.now(),
  };
}
