/**
 * Generic collection-wide signal statistics computation.
 *
 * Receives already-fetched Qdrant points and PayloadSignalDescriptors,
 * computes statistics only for signals that declare a `stats` field.
 * Qdrant scrolling is handled at the API layer — this function is pure.
 */

import { isServicePointPayload } from "../../../adapters/qdrant/service-points.js";
import { describeStatsSamplingContract, resolvePayloadValue } from "../../../contracts/signal-utils.js";
import type { FilterPresetDef } from "../../../contracts/types/filter-preset.js";
import {
  STATS_ACCUMULATOR_KEYS,
  type PointContext,
  type StatsAccumulator,
  type StatsAccumulatorDescriptor,
  type StatsPoint,
} from "../../../contracts/types/stats-accumulator.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  ScopedSignalStats,
  SignalStats,
} from "../../../contracts/types/trajectory.js";
import { detectScope, type ScopeDetectionConfig } from "../../../infra/scope-detection.js";
import { CODE_LANGUAGES } from "../pipeline/chunker/config.js";

const MIN_SAMPLE_SIZE = 10;
/**
 * A language whose share of the collection is below this floor is omitted from
 * per-language reporting as noise (misclassified extensions, a stray vendored
 * file). Shared display policy: `get_index_metrics` uses it for per-language
 * signal buckets and `get_index_status` (bd tea-rags-mcp-cnqrg) reuses it for
 * the per-language codegraph resolveSuccessRate breakdown.
 */
export const MIN_LANGUAGE_SHARE = 0.05;

/**
 * Read a value from a nested object using dot-notation path.
 * Returns undefined if any segment is missing.
 *
 * Codegraph nested form (tea-rags-mcp-0am0 + k6xu): EnrichmentApplier writes
 * codegraph signals under providerKey `codegraph.symbols`, which Qdrant
 * interprets as a path. Inner keys are BARE (tea-rags-mcp-k6xu), so the
 * real on-disk shape is:
 *   { codegraph: { symbols: { file: { fanIn: N } } } }
 * The logical descriptor key is `codegraph.{file|chunk}.<bareKey>`; we map it
 * to the nested-symbols form `codegraph.symbols.{scope}.<bareKey>` (matches
 * production), then fall back to the literal traversal so test fixtures that
 * feed flat or alternate shapes still work.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  return resolvePayloadValue(payload, path);
}

/** Whether a declared `chunkTypeFilter` — one value or several — admits this point. */
function admitsChunkType(filter: string | readonly string[], pointChunkType: unknown): boolean {
  if (typeof pointChunkType !== "string") return false;
  return typeof filter === "string" ? pointChunkType === filter : filter.includes(pointChunkType);
}

/**
 * The value this point contributes to the signal's sample, or undefined when it
 * contributes none.
 *
 * A missing key is already rejected by the `typeof` test, so the numeric floor
 * only decides what a ZERO means. It defaults to "no measurement" — the common
 * case, since most producers publish 0 for a file they never walked — and a
 * signal whose 0 is a real reading opts in via `stats.zeroIsValidObservation`.
 * Negative values are rejected either way: no signal here has a meaningful one.
 *
 * `dedupe` is supplied for signals declaring `stats.dedupeByFile`: the token
 * identifies (bucket, signal, file), so each distinct file contributes at most
 * one value to that bucket. Without it a file-scoped value repeated on every
 * chunk would let a many-chunk file dominate its own distribution. The token is
 * consumed here, so a caller that defers the push still spends the file's one
 * slot exactly once.
 */
function admittedSignalValue(
  point: { payload: Record<string, unknown> },
  signal: PayloadSignalDescriptor,
  pointChunkType: unknown,
  dedupe?: { seen: Set<string>; token: string },
): number | undefined {
  const filter = signal.stats?.chunkTypeFilter;
  if (filter !== undefined && !admitsChunkType(filter, pointChunkType)) return undefined;
  const val = readPayloadPath(point.payload, signal.key);
  if (typeof val !== "number") return undefined;
  if (!(signal.stats?.zeroIsValidObservation ? val >= 0 : val > 0)) return undefined;
  if (dedupe) {
    if (dedupe.seen.has(dedupe.token)) return undefined;
    dedupe.seen.add(dedupe.token);
  }
  return val;
}

/** Push a signal value to target array when the point contributes one. */
function tryPushSignalValue(
  point: { payload: Record<string, unknown> },
  signal: PayloadSignalDescriptor,
  pointChunkType: unknown,
  target: number[],
  dedupe?: { seen: Set<string>; token: string },
): void {
  const val = admittedSignalValue(point, signal, pointChunkType, dedupe);
  if (val !== undefined) target.push(val);
}

/**
 * Full payload key of the sibling a signal's `confidence.support` names, at the
 * signal's OWN namespace and scope — `git.chunk.bugFixRate` with
 * `support: "commitCount"` resolves to `git.chunk.commitCount`. Undefined when
 * the key carries no `{namespace}.{file|chunk}.` prefix to resolve against, or
 * when no support is declared.
 */
function supportKeyFor(signal: PayloadSignalDescriptor): string | undefined {
  const support = signal.stats?.confidence?.support;
  if (!support) return undefined;
  const m = /^(git|codegraph)\.(file|chunk)\./.exec(signal.key);
  return m ? `${m[1]}.${m[2]}.${support}` : undefined;
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

/** Stats bucket holding the global `perSignal` aggregate. */
const GLOBAL_STATS_BUCKET = "all";
/** Stats bucket holding one language's pooled aggregate — feeds the sample-size gate only. */
function languageStatsBucket(lang: string): string {
  return `lang|${lang}`;
}
/** Stats bucket holding one language's aggregate at one scope. */
function scopedStatsBucket(lang: string, scope: "source" | "test"): string {
  return `${lang}|${scope}`;
}

interface SignalValuesResult {
  valueArrays: Map<string, number[]>;
  perLanguageValues: Map<string, Map<string, number[]>>;
  perLanguageScopedValues: Map<string, Map<string, { source: number[]; test: number[] }>>;
  /** Resolved `minSupportPercentile` floors: bucket → signal key → support value. */
  supportFloors: Map<string, Map<string, number>>;
}

/**
 * One gated signal's deferred sample for one stats bucket.
 *
 * The floor is a percentile of ANOTHER signal accumulated in the SAME pass, so
 * it does not exist until the pass ends: the pairs are collected during
 * `accept` and filtered in `result`, once `support` holds the whole bucket.
 */
interface GatedSample {
  signal: PayloadSignalDescriptor;
  minSupportPercentile: number;
  bucket: string;
  /** The bucket's value array for this signal — qualified values land here. */
  target: number[];
  /** The bucket's value array for the SUPPORT signal, sampled under its own rules. */
  support: number[];
  pairs: { value: number; support: number }[];
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
  /** (bucket, signal, file) tokens already counted for `dedupeByFile` signals. */
  private readonly seenFileScoped = new Set<string>();
  /** Support key per gated signal, resolved once — empty when nothing is gated. */
  private readonly supportKeys = new Map<string, string>();
  /** Deferred samples keyed `<bucket>|<signal key>`. */
  private readonly gatedSamples = new Map<string, GatedSample>();

  constructor(private readonly statsSignals: PayloadSignalDescriptor[]) {
    this.valueArrays = new Map(statsSignals.map((s) => [s.key, []]));
    for (const signal of statsSignals) {
      if (signal.stats?.minSupportPercentile === undefined) continue;
      const supportKey = supportKeyFor(signal);
      if (supportKey !== undefined) this.supportKeys.set(signal.key, supportKey);
    }
  }

  /** Dedupe descriptor for a file-scoped signal in one bucket; undefined otherwise. */
  private fileScopedDedupe(
    signal: PayloadSignalDescriptor,
    ctx: PointContext,
    bucket: string,
  ): { seen: Set<string>; token: string } | undefined {
    if (!signal.stats?.dedupeByFile) return undefined;
    return { seen: this.seenFileScoped, token: `${bucket}|${signal.key}|${ctx.relPath}` };
  }

  accept(point: StatsPoint, ctx: PointContext): void {
    if (ctx.isCodeLanguage && ctx.scope === "source") {
      for (const signal of this.statsSignals) {
        const arr = this.valueArrays.get(signal.key);
        if (!arr) continue;
        if (signal.stats?.minSupportPercentile === undefined) {
          tryPushSignalValue(point, signal, ctx.pointChunkType, arr, this.fileScopedDedupe(signal, ctx, "all"));
          continue;
        }
        this.deferGated(point, signal, ctx, "all", GLOBAL_STATS_BUCKET, arr, this.supportValuesFor(signal));
      }
    }
    if (typeof ctx.lang !== "string") return;

    const langMap = this.langBucket(ctx.lang);
    for (const signal of this.statsSignals) {
      const langArr = langMap.get(signal.key);
      if (!langArr) continue;
      if (signal.stats?.minSupportPercentile === undefined) {
        tryPushSignalValue(point, signal, ctx.pointChunkType, langArr, this.fileScopedDedupe(signal, ctx, "lang"));
        continue;
      }
      const supportKey = this.supportKeys.get(signal.key);
      const support = supportKey === undefined ? undefined : langMap.get(supportKey);
      this.deferGated(point, signal, ctx, "lang", languageStatsBucket(ctx.lang), langArr, support);
    }

    if (ctx.scope === null) return;
    const { scope } = ctx;
    const scopedMap = this.scopedBucket(ctx.lang);
    for (const signal of this.statsSignals) {
      const scopedArr = scopedMap.get(signal.key);
      if (!scopedArr) continue;
      // A source-scope-only signal contributes nothing to the test bucket, so
      // the bucket stays empty and `computeCollectionStats` publishes no test
      // stats for it — which is what makes the reranker leave a test-scope
      // point unlabeled rather than grade it on the source ladder.
      if (scope === "test" && signal.stats?.sourceScopeOnly) continue;
      const target = scope === "test" ? scopedArr.test : scopedArr.source;
      if (signal.stats?.minSupportPercentile === undefined) {
        tryPushSignalValue(point, signal, ctx.pointChunkType, target, this.fileScopedDedupe(signal, ctx, scope));
        continue;
      }
      const supportKey = this.supportKeys.get(signal.key);
      const supportArr = supportKey === undefined ? undefined : scopedMap.get(supportKey);
      const support = scope === "test" ? supportArr?.test : supportArr?.source;
      this.deferGated(point, signal, ctx, scope, scopedStatsBucket(ctx.lang, scope), target, support);
    }
  }

  private langBucket(lang: string): Map<string, number[]> {
    let langMap = this.perLanguageValues.get(lang);
    if (!langMap) {
      langMap = new Map<string, number[]>();
      for (const signal of this.statsSignals) langMap.set(signal.key, []);
      this.perLanguageValues.set(lang, langMap);
    }
    return langMap;
  }

  private scopedBucket(lang: string): Map<string, { source: number[]; test: number[] }> {
    let scopedMap = this.perLanguageScopedValues.get(lang);
    if (!scopedMap) {
      scopedMap = new Map();
      for (const signal of this.statsSignals) scopedMap.set(signal.key, { source: [], test: [] });
      this.perLanguageScopedValues.set(lang, scopedMap);
    }
    return scopedMap;
  }

  /** The global bucket's array for a gated signal's support sibling. */
  private supportValuesFor(signal: PayloadSignalDescriptor): number[] | undefined {
    const supportKey = this.supportKeys.get(signal.key);
    return supportKey === undefined ? undefined : this.valueArrays.get(supportKey);
  }

  /**
   * Hold a gated signal's contribution back until the support distribution for
   * this bucket is complete. The point's admission (chunk-type filter, zero
   * rule, per-file dedupe) is decided NOW, so the file's one dedupe slot is
   * spent exactly as an ungated signal would spend it.
   */
  private deferGated(
    point: StatsPoint,
    signal: PayloadSignalDescriptor,
    ctx: PointContext,
    dedupeBucket: string,
    sampleBucket: string,
    target: number[],
    supportValues: number[] | undefined,
  ): void {
    const dedupe = this.fileScopedDedupe(signal, ctx, dedupeBucket);
    const value = admittedSignalValue(point, signal, ctx.pointChunkType, dedupe);
    if (value === undefined) return;

    // No support distribution in this bucket — the support sibling declares no
    // stats of its own, so no floor can be resolved here and the signal is
    // sampled exactly as an ungated one. Persisting no floor keeps the read
    // side ungated too, so both sides still describe the same population.
    if (supportValues === undefined) {
      target.push(value);
      return;
    }

    const supportKey = this.supportKeys.get(signal.key);
    const support = supportKey === undefined ? undefined : readPayloadPath(point.payload, supportKey);
    // A unit whose support was never measured cannot be shown to qualify, so it
    // does not join the sample — and the label path leaves it a bare number for
    // the same reason.
    if (typeof support !== "number") return;

    const token = `${sampleBucket}|${signal.key}`;
    let pending = this.gatedSamples.get(token);
    if (!pending) {
      pending = {
        signal,
        minSupportPercentile: signal.stats?.minSupportPercentile ?? 0,
        bucket: sampleBucket,
        target,
        support: supportValues,
        pairs: [],
      };
      this.gatedSamples.set(token, pending);
    }
    pending.pairs.push({ value, support });
  }

  result(): SignalValuesResult {
    const supportFloors = new Map<string, Map<string, number>>();
    for (const pending of this.gatedSamples.values()) {
      // Sorted COPY: the support's own array is sorted in place later by
      // `computePerSignalStats`, and the floor must be the same number that
      // pass publishes as the support's percentile.
      const sorted = [...pending.support].sort((a, b) => a - b);
      const floor = percentile(sorted, pending.minSupportPercentile);
      for (const pair of pending.pairs) {
        if (pair.support >= floor) pending.target.push(pair.value);
      }
      let perBucket = supportFloors.get(pending.bucket);
      if (!perBucket) {
        perBucket = new Map<string, number>();
        supportFloors.set(pending.bucket, perBucket);
      }
      perBucket.set(pending.signal.key, floor);
    }

    return {
      valueArrays: this.valueArrays,
      perLanguageValues: this.perLanguageValues,
      perLanguageScopedValues: this.perLanguageScopedValues,
      supportFloors,
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
  blameAuthorCounts: Map<string, number>;
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
  /** Resolved `minSupportPercentile` floors: bucket → signal key → support value. */
  supportFloors: Map<string, Map<string, number>>;
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
    (instances.get(STATS_ACCUMULATOR_KEYS.RECENT_AUTHOR_COUNTS)?.result() as Map<string, number>) ??
    new Map<string, number>();
  const blameAuthorCounts =
    (instances.get(STATS_ACCUMULATOR_KEYS.BLAME_AUTHOR_COUNTS)?.result() as Map<string, number>) ??
    new Map<string, number>();
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
    blameAuthorCounts,
    fileOldest: fileRange.fileOldest,
    fileNewest: fileRange.fileNewest,
    chunkOldest: chunkRange.chunkOldest,
    chunkNewest: chunkRange.chunkNewest,
    gitDataPaths,
    perLanguageValues: signalValues.perLanguageValues,
    perLanguageScopedValues: signalValues.perLanguageScopedValues,
    supportFloors: signalValues.supportFloors,
  };
}

/**
 * Walk all descriptors with `stats.confidence` and collect the set of
 * percentiles each support signal must provide (via `labels` keys OR
 * `percentilesToCompute`). Returns Map<supportSignalKey, Set<percentile>>.
 *
 * Three references land here: `confidence.score.adaptivePercentile`, every `pN`
 * in `confidence.label.rules[].whenSupportAtOrBelow`, and
 * `stats.minSupportPercentile` — the sampling gate reads the SAME support at the
 * same scope, and the floor it resolves is only checkable against a percentile
 * the support actually persists.
 *
 * Scope handling: descriptor's own key carries the trajectory namespace and
 * scope prefix (`git.{file|chunk}.X` or `codegraph.{file|chunk}.X`). The
 * support is bare-name (`commitCount`, `connectionCount`), resolved at the
 * SAME (namespace, scope) as the descriptor — so
 * `codegraph.file.instability` with `support: "connectionCount"` resolves
 * to `codegraph.file.connectionCount`.
 */
function collectReferencedPercentiles(signals: PayloadSignalDescriptor[]): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  for (const sig of signals) {
    const conf = sig.stats?.confidence;
    if (!conf?.support) continue;
    const m = /^(git|codegraph)\.(file|chunk)\./.exec(sig.key);
    if (!m) continue;
    const namespace = m[1];
    const scope = m[2];
    const supportFullKey = `${namespace}.${scope}.${conf.support}`;
    let set = result.get(supportFullKey);
    if (!set) {
      set = new Set<number>();
      result.set(supportFullKey, set);
    }
    if (typeof conf.score?.adaptivePercentile === "number") set.add(conf.score.adaptivePercentile);
    // The sampling gate reads the same support at the same scope, and the floor
    // it resolves is only checkable against a percentile the support persists.
    if (typeof sig.stats?.minSupportPercentile === "number") set.add(sig.stats.minSupportPercentile);
    for (const rule of conf.label?.rules ?? []) {
      if (typeof rule.whenSupportAtOrBelow === "string") {
        const p = Number(rule.whenSupportAtOrBelow.slice(1));
        if (Number.isFinite(p)) set.add(p);
      }
    }
  }
  return result;
}

/**
 * True when `sig` declares percentile `p` — either via its `stats.labels` keys
 * (as `pN`) OR via `stats.percentilesToCompute`. Single source of truth for the
 * "declares a percentile" predicate, shared by the confidence walk and the
 * filter-preset walk so both check declaration identically.
 */
function declaresPercentile(sig: PayloadSignalDescriptor, p: number): boolean {
  const fromLabels = Object.keys(sig.stats?.labels ?? {}).some((k) => Number(k.slice(1)) === p);
  if (fromLabels) return true;
  return (sig.stats?.percentilesToCompute ?? []).includes(p);
}

/**
 * Walk every filter preset's conditions and collect the percentiles each
 * referenced signal must provide. A condition references a percentile when its
 * `value` is an adaptive `{ percentile: "pN", fallback }` object; literal values
 * carry no percentile dependency. The signal is resolved by LOGICAL key
 * (`condition.signal`) — the same form used in the payload descriptor's `key`.
 */
function collectFilterReferencedPercentiles(
  filterPresets: readonly FilterPresetDef[],
): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  for (const preset of filterPresets) {
    for (const condition of preset.conditions) {
      const { value } = condition;
      if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
      if (!("percentile" in value)) continue;
      const p = Number(value.percentile.slice(1));
      if (!Number.isFinite(p)) continue;
      let perSignal = result.get(condition.signal);
      if (!perSignal) {
        perSignal = new Map<number, string>();
        result.set(condition.signal, perSignal);
      }
      if (!perSignal.has(p)) perSignal.set(p, preset.name);
    }
  }
  return result;
}

/**
 * Validate that every percentile referenced by a descriptor's confidence block
 * is declared on the support signal — either via its `stats.labels` keys
 * (as `pN`) OR via `stats.percentilesToCompute`. Throws at descriptor-load
 * time if any reference is unwired. Loud failure is intentional: silent
 * fallback to `rule.fallback` masks misconfiguration.
 *
 * Filter presets (optional second arg) extend the same contract: an adaptive
 * `{ percentile: "pN" }` condition resolves against collection stats at SEARCH
 * time with no lazy-recompute machinery, so the referenced `pN` MUST be computed
 * at index time. Each filter-referenced `pN` must therefore be declared on its
 * signal (labels OR percentilesToCompute) exactly like a confidence reference.
 * Default `[]` keeps the existing single-arg callers unchanged (back-compat).
 *
 * Call at composition time after assembling all trajectories' signals into
 * a single descriptor list.
 */
export function validateSignalDependencies(
  signals: PayloadSignalDescriptor[],
  filterPresets: readonly FilterPresetDef[] = [],
): void {
  const referenced = collectReferencedPercentiles(signals);
  for (const [supportKey, percentiles] of referenced) {
    const supportSig = signals.find((s) => s.key === supportKey);
    if (!supportSig) {
      throw new Error(
        `Signal dependency error: a descriptor references support "${supportKey}" via confidence.support, but no such PayloadSignalDescriptor is declared.`,
      );
    }
    for (const p of percentiles) {
      if (!declaresPercentile(supportSig, p)) {
        throw new Error(
          `Signal dependency error: a descriptor references "${supportKey}" percentile p${p} ` +
            `(via confidence.score.adaptivePercentile, confidence.label.rules[].whenSupportAtOrBelow ` +
            `or stats.minSupportPercentile), ` +
            `but ${supportKey} declares neither p${p} in stats.labels nor ${p} in stats.percentilesToCompute. ` +
            `Add ${p} to ${supportKey}.stats.percentilesToCompute (or p${p} to stats.labels if it should be a labeled tier).`,
        );
      }
    }
  }

  const filterReferenced = collectFilterReferencedPercentiles(filterPresets);
  for (const [signalKey, perSignal] of filterReferenced) {
    const sig = signals.find((s) => s.key === signalKey);
    for (const [p, presetName] of perSignal) {
      if (!sig) {
        throw new Error(
          `Signal dependency error: filter preset "${presetName}" references signal "${signalKey}" ` +
            `percentile p${p}, but no such PayloadSignalDescriptor is declared.`,
        );
      }
      if (!declaresPercentile(sig, p)) {
        throw new Error(
          `Signal dependency error: filter preset "${presetName}" references "${signalKey}" percentile p${p} ` +
            `(via an adaptive { percentile } condition), but ${signalKey} declares neither p${p} in stats.labels ` +
            `nor ${p} in stats.percentilesToCompute. Filter percentiles resolve at search time with no lazy ` +
            `recompute — add ${p} to ${signalKey}.stats.percentilesToCompute (or p${p} to stats.labels).`,
        );
      }
    }
  }
}

function computePerSignalStats(
  valueArrays: Map<string, number[]>,
  statsSignals: PayloadSignalDescriptor[],
  /**
   * Resolved support floors for the bucket these arrays belong to. Recorded
   * alongside the percentiles so the read side excludes exactly the units the
   * bands were computed without, instead of re-deriving a number of its own.
   */
  supportFloors?: Map<string, number>,
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

    // Compute any extra percentiles declared for cross-signal references
    // (e.g. another descriptor's confidence block references "p10" of this
    // signal — percentilesToCompute lets the support signal opt in).
    if (req.percentilesToCompute) {
      for (const p of req.percentilesToCompute) {
        if (Number.isFinite(p) && result.percentiles[p] === undefined) {
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

    const floor = supportFloors?.get(signal.key);
    if (floor !== undefined) result.supportFloor = floor;

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

  const sortedBlameAuthors = Array.from(extracted.blameAuthorCounts.entries()).sort((a, b) => b[1] - a[1]);
  const topBlameAuthors = sortedBlameAuthors.slice(0, 10).map(([name, chunks]) => ({ name, chunks }));

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
    topBlameAuthors,
    othersCount,
    enrichmentTimeRange,
  };
}

/**
 * Compute collection-wide stats for PayloadSignalDescriptors that declare a `stats` field.
 *
 * - Filters to signals WITH `stats` request (not just numeric type)
 * - Resolves dot-notation paths against each point's payload
 * - Skips missing/non-numeric/negative values, and zeros unless the signal
 *   declares `stats.zeroIsValidObservation`
 * - Computes only what's declared: percentiles, mean, stddev
 * - Returns empty perSignal map for signals with no valid values
 */
export function computeCollectionStats(
  points: StatsPoint[],
  signals: PayloadSignalDescriptor[],
  trajectoryAccumulators: readonly StatsAccumulatorDescriptor[],
  gitTimePeriods?: { fileMonths: number; chunkMonths: number },
): CollectionSignalStats {
  // The stats scroll reads every point of the collection. The indexing marker
  // and the schema metadata point are not chunks: counted, they pad the `code`
  // distribution and the language-share denominator (bd tea-rags-mcp-39xca.12).
  const chunkPoints = points.filter((point) => !isServicePointPayload(point.payload));
  const statsSignals = signals.filter((s) => s.stats !== undefined);
  const extracted = extractSignalValues(chunkPoints, statsSignals, trajectoryAccumulators);
  const perSignal = computePerSignalStats(
    extracted.valueArrays,
    statsSignals,
    extracted.supportFloors.get(GLOBAL_STATS_BUCKET),
  );
  const distributions = buildDistributions(extracted, gitTimePeriods);

  const totalChunks = chunkPoints.length;
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

    const sourceFloors = extracted.supportFloors.get(scopedStatsBucket(lang, "source"));
    const testFloors = extracted.supportFloors.get(scopedStatsBucket(lang, "test"));

    const scopedStats = new Map<string, ScopedSignalStats>();
    for (const [key, { source: sourceValues, test: testValues }] of scopedMap) {
      const sourceArr = new Map<string, number[]>([[key, sourceValues]]);
      const sourceStats = computePerSignalStats(sourceArr, statsSignals, sourceFloors).get(key);
      if (!sourceStats) continue;

      const testArr = new Map<string, number[]>([[key, testValues]]);
      const testStats =
        testValues.length > 0 ? computePerSignalStats(testArr, statsSignals, testFloors).get(key) : undefined;

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
    // Stamped here rather than by the caller: the contract describes the sample
    // this call just took, and the two must not be able to disagree.
    samplingContract: describeStatsSamplingContract(statsSignals),
  };
}
