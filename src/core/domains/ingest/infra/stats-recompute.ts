/**
 * StatsRecomputeService — lazy hot recompute for missing percentiles.
 *
 * Trigger: at stats-load time (`ExploreOps.ensureStats`), the service
 * walks every confidence-block percentile reference declared by payload
 * signals and checks whether the loaded `CollectionSignalStats` already
 * has `perSignal[K].percentiles[N]` for each. If anything is missing
 * (stale-index case: descriptor was added/changed after the last full
 * reindex), the service backfills ONLY the missing entries.
 *
 * What gets recomputed:
 *   - ONE scroll per support SIGNAL (not per percentile). All missing
 *     percentiles of the same signal share that scroll.
 *   - ONE sort per support signal.
 *   - ONE percentile read per missing `(signalKey, p)` pair.
 *   - ONE atomic stats-cache save at the end of ensureCoverage if any
 *     percentile was added. Persists the full stats blob (snapshot
 *     pattern), with every other field unchanged from the loaded value.
 *
 * What stays unchanged: `count`, `min`, `max`, `mean`, `stddev`, every
 * pre-existing percentile. The merge is an in-place insert into
 * `SignalStats.percentiles` only.
 *
 * Concurrency: per-(collection, signal) in-flight memo on the scroll.
 * Two queries that trigger ensureCoverage at the same time scroll each
 * signal exactly once.
 *
 * Failure: on scroll error or empty result for a signal the service logs
 * at WARN level, records a 60s backoff for that key, and leaves the
 * stats untouched for THAT signal's missing percentiles. Other signals
 * proceed independently.
 *
 * See spec: docs/superpowers/specs/2026-05-15-lazy-percentile-recompute-design.md
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import { scrollAllPoints } from "../../../adapters/qdrant/scroll.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalStats,
} from "../../../contracts/types/trajectory.js";
import type { StatsCache } from "../../../infra/stats-cache.js";

const FAILURE_BACKOFF_MS = 60_000;

export class StatsRecomputeService {
  private readonly inFlight = new Map<string, Promise<number[]>>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly statsCache: StatsCache,
  ) {}

  /**
   * Cold-start coverage check. Idempotent and side-effect-free when no
   * descriptor references a percentile missing from stats — that's the
   * normal post-reindex state. When the index is stale relative to
   * descriptor declarations, this fills the gaps in-place and persists.
   */
  async ensureCoverage(
    collectionName: string,
    stats: CollectionSignalStats,
    payloadSignals: PayloadSignalDescriptor[],
    payloadFieldKeys?: string[],
  ): Promise<void> {
    const grouped = collectMissingPercentilesGrouped(stats, payloadSignals);
    if (grouped.size === 0) return;

    const mutatedFlags = await Promise.all(
      [...grouped.entries()].map(async ([signalKey, percentiles]) =>
        this.backfillSignal(collectionName, stats, signalKey, percentiles),
      ),
    );
    const mutated = mutatedFlags.some(Boolean);
    if (!mutated) return;

    try {
      this.statsCache.save(collectionName, stats, payloadFieldKeys);
    } catch (err) {
      console.warn(
        `[stats-recompute] persist failed for ${collectionName}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Scroll the signal ONCE, sort ONCE, compute every missing percentile
   * for this signal in a single pass. Mutates `SignalStats.percentiles`
   * in place for each newly computed entry. Returns whether anything
   * was mutated (drives whether a save is needed).
   */
  private async backfillSignal(
    collectionName: string,
    stats: CollectionSignalStats,
    signalKey: string,
    percentiles: Set<number>,
  ): Promise<boolean> {
    const supportStats = stats.perSignal.get(signalKey);
    if (!supportStats) return false;

    const values = await this.getSortedValues(collectionName, signalKey);
    if (values === undefined || values.length === 0) return false;

    let mutated = false;
    for (const p of percentiles) {
      // Race-safe: another concurrent ensureCoverage may have populated it.
      if (supportStats.percentiles?.[p] !== undefined) continue;
      mergePercentile(supportStats, p, percentile(values, p));
      mutated = true;
    }
    return mutated;
  }

  /**
   * Per-(collection, signal) memoized scroll. Concurrent callers receive
   * the same Promise; the scroll runs once. On failure or empty result
   * records a short backoff to avoid retry storms.
   */
  private async getSortedValues(collectionName: string, signalKey: string): Promise<number[] | undefined> {
    const cacheKey = `${collectionName}:${signalKey}`;
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const failedAt = this.failedAt.get(cacheKey);
    if (failedAt !== undefined && Date.now() - failedAt < FAILURE_BACKOFF_MS) {
      return undefined;
    }

    const promise = this.doScroll(collectionName, signalKey).finally(() => {
      this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, promise);

    try {
      const values = await promise;
      if (values.length === 0) this.failedAt.set(cacheKey, Date.now());
      return values;
    } catch (err) {
      console.warn(
        `[stats-recompute] scroll failed for ${signalKey} in ${collectionName}: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.failedAt.set(cacheKey, Date.now());
      return undefined;
    }
  }

  private async doScroll(collectionName: string, signalKey: string): Promise<number[]> {
    const points = await scrollAllPoints(this.qdrant, collectionName);
    const values: number[] = [];
    for (const point of points) {
      const v = readPayloadPath(point.payload, signalKey);
      if (typeof v === "number" && v > 0) values.push(v);
    }
    values.sort((a, b) => a - b);
    return values;
  }
}

/**
 * Walk all payload-signal confidence references and collect missing
 * percentiles GROUPED BY support signal. One scroll per signal will
 * then resolve every missing percentile for that signal at once.
 *
 * Axes:
 *   - score-side: `confidence.score.adaptivePercentile` (default 25),
 *     always file-scope support (mirrors `Reranker.resolveDampeningThreshold`).
 *   - label-side: every `confidence.label.rules[].whenSupportBelow: "pN"`,
 *     same scope as the descriptor's raw key (file/chunk).
 */
function collectMissingPercentilesGrouped(
  stats: CollectionSignalStats,
  payloadSignals: PayloadSignalDescriptor[],
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const enqueue = (signalKey: string, percentile: number): void => {
    if (!Number.isFinite(percentile)) return;
    const supportStats = stats.perSignal.get(signalKey);
    if (!supportStats) return;
    if (supportStats.percentiles?.[percentile] !== undefined) return;
    let bucket = out.get(signalKey);
    if (!bucket) {
      bucket = new Set();
      out.set(signalKey, bucket);
    }
    bucket.add(percentile);
  };

  for (const raw of payloadSignals) {
    const confidence = raw.stats?.confidence;
    if (!confidence?.support) continue;
    const scope: "file" | "chunk" = raw.key.startsWith("git.chunk.") ? "chunk" : "file";

    // Score-side dampening always reads file-scope support.
    if (confidence.score) {
      const fileSupportKey = resolveSiblingFullKey(raw.key, confidence.support, "file");
      if (fileSupportKey) enqueue(fileSupportKey, confidence.score.adaptivePercentile ?? 25);
    }

    if (confidence.label) {
      const supportKey = resolveSiblingFullKey(raw.key, confidence.support, scope);
      if (!supportKey) continue;
      for (const rule of confidence.label.rules) {
        if (typeof rule.whenSupportBelow !== "string") continue;
        const pct = Number(rule.whenSupportBelow.slice(1));
        enqueue(supportKey, pct);
      }
    }
  }
  return out;
}

/**
 * Resolve a bare sibling name (`commitCount`) to a full payload key for the
 * given scope, using the raw signal's namespace prefix:
 *   raw.key="git.file.bugFixRate", support="commitCount", scope="file"
 *     → "git.file.commitCount"
 *   raw.key="git.chunk.bugFixRate", support="commitCount", scope="chunk"
 *     → "git.chunk.commitCount"
 */
function resolveSiblingFullKey(rawKey: string, bareName: string, scope: "file" | "chunk"): string | undefined {
  const parts = rawKey.split(".");
  if (parts.length < 3) return undefined;
  return `${parts[0]}.${scope}.${bareName}`;
}

/**
 * Insert a single percentile entry into `SignalStats.percentiles` IN PLACE.
 * All other fields on `stats` and pre-existing percentile entries are
 * preserved exactly. Critical for downstream consumers (label resolver,
 * adaptive bounds, get_index_metrics) that read those fields.
 */
function mergePercentile(stats: SignalStats, p: number, value: number): void {
  if (!stats.percentiles) {
    stats.percentiles = { [p]: value };
    return;
  }
  stats.percentiles[p] = value;
}

/** Mirrors collection-stats percentile() — linear interpolation on a sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/**
 * Read a value from Qdrant payload via dot-path, tolerating both flat
 * ("git.file.commitCount" key) and nested ({git: {file: {commitCount}}}) shapes.
 * Mirrors readPayloadPath in collection-stats — kept local to avoid
 * re-exporting an ingest-internal helper.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  if (path in payload) return payload[path];
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
