/**
 * Reranker module for search result scoring
 *
 * Descriptor-based scoring: each DerivedSignalDescriptor knows how to
 * extract its normalized value from the raw signals. The Reranker:
 * 1. Computes per-source adaptive bounds (p95 from batch, floored with defaultBound per-descriptor)
 * 2. Calls descriptor.extract(rawSignals, { bounds, dampeningThreshold }) for each signal
 * 3. Computes weighted sum score
 * 4. Attaches ranking overlay (raw file/chunk signals for transparency)
 */

import { isLevelQualifiedPayloadKey, p95, resolvePayloadValue } from "../../contracts/signal-utils.js";
import type { ScoringWeights } from "../../contracts/types/provider.js";
import type {
  AgeDerivationCapability,
  DerivedSignalDescriptor,
  OverlayMask,
  RankingOverlay,
  RerankableResult,
  RerankMode,
  RerankPreset,
  SignalLevel,
} from "../../contracts/types/reranker.js";
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalConfidence,
  SignalFloors,
} from "../../contracts/types/trajectory.js";
import { detectScope } from "../../infra/scope-detection.js";
import type { StatsRecomputeService } from "../ingest/infra/stats-recompute.js";
import { resolveLabel } from "./label-resolver.js";
import { ageSourceBoundDays, applySignalFloors, floorsForSignal } from "./signal-floors.js";

// Re-export types as part of search module's public API
export type { ScoringWeights } from "../../contracts/types/provider.js";
export type { RerankableResult, RerankMode } from "../../contracts/types/reranker.js";

/** Options for Reranker.rerank() — consolidates optional parameters. */
export interface RerankOptions {
  signalLevel?: SignalLevel;
  query?: string;
  /**
   * When false, overlays are still computed and attached but the final
   * score-descending sort is skipped — the returned array preserves input
   * order. Default true (sort as before). Used by trace_path to annotate a
   * path with danger overlays without disturbing execution order.
   * Note: a preset with `groupBy` still runs its group-dedup pass under
   * reorder:false, so the per-group representative is the first input-order
   * entry, not the highest-scored.
   */
  reorder?: boolean;
  /**
   * Query-time reference clock, unix SECONDS (the lastModifiedAt unit).
   * Injected once per rerank into `ExtractContext.now`, the age-source
   * adaptive bounds and the overlay ageDays resolution, so age derives from
   * lastModifiedAt at read time (bd tea-rags-mcp-9ot33). Defaults to the
   * current time; tests pin it for determinism.
   */
  now?: number;
}

/**
 * Output of `resolveMode()` — the resolved rerank configuration derived from
 * `mode` (string preset / {preset,custom} / pure {custom}).
 */
interface ResolvedMode {
  presetName: string;
  weights: ScoringWeights;
  mask: OverlayMask | undefined;
  groupBy: string | undefined;
  signalLevel: SignalLevel | undefined;
}

// ---------------------------------------------------------------------------
// Reranker — descriptor-based scoring with ranking overlay
// ---------------------------------------------------------------------------

/**
 * Reranker — descriptor-based scoring with ranking overlay.
 *
 * Uses DerivedSignalDescriptor.extract(rawSignals, ctx) for all signal extraction.
 * Applies adaptive bounds (p95 from result batch, floored with defaultBound).
 * Confidence dampening is handled by each descriptor internally.
 * Attaches RankingOverlay to explain WHY each result scored the way it did.
 */
export class Reranker {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;
  private readonly signalKeyMap: Map<string, string>;
  private readonly payloadSignals: PayloadSignalDescriptor[];
  private collectionStats?: CollectionSignalStats;
  private collectionName?: string;
  /** Opaque marker of the stats revision held, supplied by whoever loaded it. */
  private collectionStatsRevision?: number;
  private payloadFieldKeys?: string[];
  private recomputeService?: StatsRecomputeService;
  private resolvedFilterPresetNames: string[] = [];
  private ageCapabilityMap?: Map<string, { cap: AgeDerivationCapability; level: "file" | "chunk" }>;

  constructor(
    private readonly descriptors: DerivedSignalDescriptor[],
    private readonly resolvedPresets: RerankPreset[],
    payloadSignals: PayloadSignalDescriptor[] = [],
    /**
     * Per-language structural-signal floors, injected by the composition root
     * from `LanguageFactoryDescriptor.signalFloors()`. Absent (tests, fixtures)
     * → overlay labels stay purely percentile-derived.
     */
    private readonly signalFloors?: ReadonlyMap<string, SignalFloors>,
  ) {
    this.descriptorMap = new Map();
    for (const d of this.descriptors) {
      this.descriptorMap.set(d.name, d);
    }
    this.payloadSignals = payloadSignals;
    this.signalKeyMap = buildSignalKeyMap(payloadSignals);
  }

  /** Whether collection-level stats are currently loaded. */
  get hasCollectionStats(): boolean {
    return this.collectionStats !== undefined;
  }

  /**
   * Whether the stats currently held are the ones this collection wants, at the
   * revision the caller has observed on disk.
   *
   * This — not `hasCollectionStats` — is what a loader must ask. The bare
   * predicate answers "is anything loaded", which was true the moment the first
   * collection of the process was searched, so every later collection inherited
   * that project's distribution and a recompute by another process was never
   * picked up (bd tea-rags-mcp-yntsd). The revision stays opaque here: the
   * reranker must not know that stats live in a file.
   */
  hasCollectionStatsFor(collectionName: string, revision?: number): boolean {
    if (this.collectionStats === undefined) return false;
    return this.collectionName === collectionName && this.collectionStatsRevision === revision;
  }

  /**
   * Read the loaded collection stats (undefined when none loaded).
   * Consumed at search-stage filter resolution so the filter-preset compiler
   * can resolve adaptive percentile thresholds with the same stats the
   * reranker uses.
   */
  getCollectionStats(): CollectionSignalStats | undefined {
    return this.collectionStats;
  }

  /** Set collection-wide signal stats (computed after indexing). */
  setCollectionStats(
    stats: CollectionSignalStats,
    opts?: { collectionName?: string; payloadFieldKeys?: string[]; revision?: number },
  ): void {
    this.collectionStats = stats;
    this.collectionName = opts?.collectionName;
    this.collectionStatsRevision = opts?.revision;
    this.payloadFieldKeys = opts?.payloadFieldKeys;
  }

  /**
   * Wire the lazy stats-recompute service. Required for the rerank-time
   * lazy backfill of missing confidence-referenced percentiles. Without
   * this, missing adaptive percentiles fall back to `rule.fallback` /
   * `score.threshold` for every query — useful for tests / fixtures.
   */
  setRecomputeService(service: StatsRecomputeService): void {
    this.recomputeService = service;
  }

  /** Invalidate stats (called when reindex starts). */
  invalidateStats(): void {
    this.collectionStats = undefined;
    this.collectionName = undefined;
    this.collectionStatsRevision = undefined;
    this.payloadFieldKeys = undefined;
  }

  /**
   * Rerank results with ranking overlay.
   *
   * Lazy-at-rerank: BEFORE scoring, walks every confidence reference declared
   * by payload signals (score `adaptivePercentile`, label rule `whenSupportAtOrBelow: "pN"`)
   * and awaits a single-percentile scroll for each one missing from current
   * collection stats. Idempotent across reranks — `requestRecompute` checks
   * in-memory stats first, so a percentile populated by an earlier rerank
   * skips the scroll on subsequent reranks. Net effect: scroll fires ONLY
   * when actually needed, at the moment of need.
   */
  async rerank<T extends RerankableResult>(
    results: T[],
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
    options?: RerankOptions,
  ): Promise<(T & { rankingOverlay?: RankingOverlay })[]> {
    const resolved = this.resolveMode(mode, presetSet);
    if (options?.signalLevel) {
      resolved.signalLevel = options.signalLevel;
    }
    if (isSimilarityOnly(resolved.weights)) {
      return results.map((r) => ({ ...r }));
    }
    await this.ensureNeededPercentiles();
    const now = options?.now ?? Math.floor(Date.now() / 1000);
    const bounds = this.computeAdaptiveBounds(results, now);
    const scored = this.scoreResults(results, bounds, resolved, options?.query, now);
    const ordered = options?.reorder === false ? scored : scored.sort((a, b) => b.score - a.score);
    return resolved.groupBy ? groupByTop(ordered, resolved.groupBy) : ordered;
  }

  /**
   * Lazy pre-pass: walk confidence references on payload signals, identify
   * percentiles missing from loaded stats, await their backfill. Cheap when
   * everything is present (Map lookups). Scrolls only fire for missing
   * percentiles; the recompute service groups by signal (one scroll per
   * support signal, multiple percentiles share that scroll) and persists
   * via stats-cache once.
   *
   * No-op when the recompute service / stats / collectionName aren't wired
   * (e.g. tests without infra). Adaptive resolution then degrades to the
   * static `score.threshold` / `rule.fallback` path.
   */
  private async ensureNeededPercentiles(): Promise<void> {
    if (!this.recomputeService || !this.collectionStats || !this.collectionName) return;
    await this.recomputeService.ensureCoverage(
      this.collectionName,
      this.collectionStats,
      this.payloadSignals,
      this.payloadFieldKeys,
    );
  }

  /** Resolve `mode` to weights, mask, groupBy, signalLevel. Pure lookup, no side effects. */
  private resolveMode(
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
  ): ResolvedMode {
    let weights: ScoringWeights;
    let presetName: string;
    let mask: OverlayMask | undefined;
    let groupBy: string | undefined;
    let signalLevel: SignalLevel | undefined;
    if (typeof mode === "string") {
      presetName = mode;
      const fullPreset = this.resolvedPresets.find((p) => p.name === mode && this.matchesTool(p, presetSet));
      weights = fullPreset?.weights ?? { similarity: 1.0 };
      mask = fullPreset?.overlayMask;
      groupBy = fullPreset?.groupBy;
      signalLevel = fullPreset?.signalLevel;
    } else if (mode.preset) {
      presetName = mode.preset;
      weights = mode.custom;
      const fullPreset = this.resolvedPresets.find((p) => p.name === mode.preset && this.matchesTool(p, presetSet));
      mask = fullPreset?.overlayMask;
      groupBy = fullPreset?.groupBy;
      signalLevel = fullPreset?.signalLevel;
    } else {
      presetName = "custom";
      weights = mode.custom;
    }
    return { presetName, weights, mask, groupBy, signalLevel };
  }

  /** Score each result and attach ranking overlay. Pure transform given bounds + resolved mode. */
  private scoreResults<T extends RerankableResult>(
    results: T[],
    bounds: Map<string, number>,
    resolved: ResolvedMode,
    query: string | undefined,
    nowSec: number,
  ): (T & { score: number; rankingOverlay?: RankingOverlay })[] {
    // Batch min-max range of the raw vector score. The similarity signal reads a
    // normalized score so preset weights mean the same thing whether the score
    // came from cosine (semantic_search, ~0.5-0.85 narrow) or RRF fusion
    // (hybrid_search, rank-shaped/hyperbolic). Reached only past the
    // isSimilarityOnly fast path, so similarity-only ranking is untouched.
    const scoreRange = computeScoreRange(results);
    return results.map((result) => {
      const payload = this.buildExtractPayload(result, normalizeSimilarityScore(result.score, scoreRange));
      const signals = this.extractAllDerived(payload, bounds, resolved.signalLevel, query, nowSec);
      const score = calculateScore(signals, resolved.weights);
      const overlay = this.buildOverlay(
        result,
        resolved.presetName,
        resolved.weights,
        signals,
        resolved.mask,
        resolved.signalLevel,
        nowSec,
      );
      return { ...result, score, rankingOverlay: overlay };
    });
  }

  /**
   * Get preset weights for a specific preset name and tool.
   */
  getPreset(
    name: string,
    tool: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
  ): ScoringWeights | undefined {
    return this.resolvedPresets.find((p) => p.name === name && this.matchesTool(p, tool))?.weights;
  }

  /**
   * Get full preset object for a specific preset name and tool.
   */
  getFullPreset(
    name: string,
    tool: "semantic_search" | "search_code" | "rank_chunks" | "trace_path",
  ): RerankPreset | undefined {
    return this.resolvedPresets.find((p) => p.name === name && this.matchesTool(p, tool));
  }

  /**
   * Get available preset names for a tool.
   */
  getAvailablePresets(tool: "semantic_search" | "search_code" | "rank_chunks" | "trace_path"): string[] {
    return this.resolvedPresets.filter((p) => this.matchesTool(p, tool)).map((p) => p.name);
  }

  /** Descriptor info for MCP schema generation. */
  getDescriptorInfo(): { name: string; description: string }[] {
    return this.descriptors.map((d) => ({ name: d.name, description: d.description }));
  }

  /** All derived signal descriptors (for RankModule). */
  getDescriptors(): DerivedSignalDescriptor[] {
    return this.descriptors;
  }

  /** Preset names for a specific tool. */
  getPresetNames(tool: string): string[] {
    return this.resolvedPresets.filter((p) => this.matchesTool(p, tool)).map((p) => p.name);
  }

  /**
   * Set the registered filter-preset names. Wired at composition time from
   * TrajectoryRegistry.filterPresetNames() so the MCP schema layer (SchemaBuilder)
   * can surface them through its single Reranker dependency, mirroring how rerank
   * preset names are exposed via getPresetNames().
   */
  setFilterPresetNames(names: readonly string[]): void {
    this.resolvedFilterPresetNames = [...names];
  }

  /** Registered filter-preset names (for the MCP `filter` param `{ presets }` arm). */
  filterPresetNames(): string[] {
    return [...this.resolvedFilterPresetNames];
  }

  /** Payload signal descriptors (for dynamic resource generation). */
  getPayloadSignals(): PayloadSignalDescriptor[] {
    return this.payloadSignals;
  }

  /** Preset names + descriptions for a specific tool (for MCP schema generation). */
  getPresetDescriptions(tool: string): { name: string; description: string }[] {
    return this.resolvedPresets
      .filter((p) => this.matchesTool(p, tool))
      .map((p) => ({ name: p.name, description: p.description }));
  }

  /** Full preset details for resource documentation. */
  getPresetDetails(tool: string): { name: string; description: string; weights: string[]; tools: string[] }[] {
    return this.resolvedPresets
      .filter((p) => this.matchesTool(p, tool))
      .map((p) => ({
        name: p.name,
        description: p.description,
        weights: Object.keys(p.weights).filter((k) => p.weights[k as keyof typeof p.weights] !== undefined),
        tools: [...p.tools],
      }));
  }

  // -- Private methods --

  /** Check if a preset serves the given tool. */
  private matchesTool(preset: RerankPreset, tool: string): boolean {
    return preset.tools.includes(tool);
  }

  /**
   * Build the payload Record<string, unknown> used by descriptor extract().
   * Includes _score field for similarity descriptor and all payload fields.
   */
  private buildExtractPayload(result: RerankableResult, similarityScore: number): Record<string, unknown> {
    return { _score: similarityScore, ...(result.payload ?? {}) };
  }

  /**
   * Compute adaptive bounds from the result batch — per-source.
   * For each unique source across all descriptors, read raw values from every payload,
   * compute p95, and floor with collection-level p95.
   * Age sources (descriptors carrying an `ageDerivation` capability) branch:
   * their raw values are lastModifiedAt timestamps, so the batch p95 is taken
   * over the DERIVED whole-day ages and floored with the now-relative
   * collection floor `now − p5(lastModifiedAt)` (bd tea-rags-mcp-9ot33).
   * Returns Map<sourceKey, adaptiveBound> — age-days for age sources, raw
   * value units for everything else.
   */
  private computeAdaptiveBounds(results: RerankableResult[], nowSec: number): Map<string, number> {
    const rawValues = new Map<string, number[]>();

    for (const result of results) {
      for (const d of this.descriptors) {
        if (d.defaultBound === undefined) continue;
        if (d.ageDerivation) {
          // Age branch: derive ages now; raw per-source collection happens in
          // the loop below for every other descriptor family.
          continue;
        }
        for (const source of d.sources) {
          const raw = this.readRawSource(result, source);
          if (raw !== undefined && raw > 0) {
            let arr = rawValues.get(source);
            if (!arr) {
              arr = [];
              rawValues.set(source, arr);
            }
            arr.push(raw);
          }
        }
      }
    }

    const sourceBounds = new Map<string, number>();
    for (const [source, values] of rawValues) {
      const batchP95 = p95(values);
      const collectionP95 = this.getCollectionPercentile(source, 95);
      sourceBounds.set(source, Math.max(batchP95, collectionP95 ?? 0));
    }

    for (const d of this.descriptors) {
      if (d.defaultBound === undefined || !d.ageDerivation) continue;
      const cap = d.ageDerivation;
      for (const source of d.sources) {
        const level = source.startsWith("chunk.") ? "chunk" : "file";
        const ages: number[] = [];
        for (const result of results) {
          const age = cap.ageDaysFrom(result.payload ?? {}, level, nowSec);
          if (age !== undefined && age > 0) ages.push(age);
        }
        const stampP5 = this.getCollectionPercentile(source, 5);
        sourceBounds.set(
          source,
          ageSourceBoundDays(ages, stampP5, nowSec, (stamp, now) => cap.ageFloorDaysFromStamp(stamp, now)),
        );
      }
    }

    return sourceBounds;
  }

  /**
   * Extract all derived signal values from a payload.
   * Builds per-descriptor bounds record from source-level bounds.
   * When collectionStats is loaded, sourceBounds already contains max(batchP95, collP95)
   * which is fully adaptive — no static floor needed.
   * Without collectionStats, defaultBound serves as a static fallback floor.
   */
  private extractAllDerived(
    payload: Record<string, unknown>,
    sourceBounds: Map<string, number>,
    signalLevel?: SignalLevel,
    query?: string,
    nowSec?: number,
  ): Record<string, number> {
    const signals: Record<string, number> = {};

    for (const d of this.descriptors) {
      const bounds: Record<string, number> = {};
      for (const source of d.sources) {
        const sourceBound = sourceBounds.get(source) ?? 0;
        // With collection stats: adaptive bounds only (minimal floor of 1 for safety).
        // Without stats: defaultBound as static fallback floor.
        const floor = this.collectionStats ? 1 : (d.defaultBound ?? 1);
        bounds[source] = Math.max(sourceBound, floor);
      }
      const dampeningThreshold = this.resolveDampeningThreshold(d);
      const dampeningThresholdChunk = this.resolveDampeningThresholdChunk(d);
      const confidence = this.resolveDerivedConfidence(d);
      signals[d.name] = d.extract(payload, {
        bounds,
        dampeningThreshold,
        dampeningThresholdChunk,
        confidence,
        collectionStats: this.collectionStats,
        signalLevel,
        query,
        now: nowSec,
      });
    }

    return signals;
  }

  /**
   * Resolve the FILE-scope dampening threshold (k_f) for a derived signal.
   *
   * Reads `stats.confidence.support` (the support sibling name) from the raw
   * payload descriptor, looks up its `adaptivePercentile` (default 25) in
   * `{trajectory}.file.{support}` collection stats, and returns the LARGER of
   * that adaptive value and the descriptor's declared `confidence.score.threshold`.
   * Returns undefined when neither is available (no collection stats, no
   * confidence block, unresolvable support) — the derived signal then runs its
   * own fallback chain down to its defensive `FALLBACK_K`.
   *
   * Why max() and not adaptive-first (bd tea-rags-mcp-1lyui): support
   * distributions are atomic counts, so on a young or wide codebase a low
   * percentile collapses onto the distribution's minimum. `git.file.commitCount`
   * p25 measured 1 on the tea-rags self-index, and `confidenceDampening(n, k)`
   * returns 1 whenever `n >= k`, so k=1 disabled the score path for every point
   * with at least one commit — corpus-wide, and hardest exactly where small-N
   * suppression matters. The descriptor's declared threshold is the floor that
   * guards against that; the adaptive value still wins whenever it is larger,
   * so the curve keeps scaling with a codebase whose support distribution is
   * genuinely rich.
   */
  private resolveDampeningThreshold(descriptor: DerivedSignalDescriptor): number | undefined {
    return this.resolveDampeningThresholdForScope(descriptor, "file");
  }

  /**
   * Resolve the CHUNK-scope dampening threshold (k_c) — same
   * `max(adaptive percentile, declared floor)` rule as
   * {@link resolveDampeningThreshold}, but reading `chunk.{support}` collection
   * stats, so blended signals dampen their chunk component by its own sample
   * size. Chunk supports are even smaller than file supports, so the declared
   * floor carries more of the work here than at file scope. Returns undefined
   * when neither side resolves (e.g. file-only support with no declared floor).
   */
  private resolveDampeningThresholdChunk(descriptor: DerivedSignalDescriptor): number | undefined {
    return this.resolveDampeningThresholdForScope(descriptor, "chunk");
  }

  private resolveDampeningThresholdForScope(
    descriptor: DerivedSignalDescriptor,
    scope: "file" | "chunk",
  ): number | undefined {
    if (!this.collectionStats) return undefined;
    const confidence = this.resolveDerivedConfidence(descriptor);
    if (!confidence?.support) return undefined;
    const supportFullKey = this.signalKeyMap.get(`${scope}.${confidence.support}`);
    if (!supportFullKey) return undefined;
    const stats = this.collectionStats.perSignal.get(supportFullKey);
    const percentile = confidence.score?.adaptivePercentile ?? 25;
    const adaptive = stats?.percentiles?.[percentile];
    const floor = confidence.score?.threshold;
    if (adaptive === undefined) return floor;
    if (floor === undefined) return adaptive;
    return Math.max(adaptive, floor);
  }

  /**
   * Look up the raw payload descriptor's `stats.confidence` block for a derived
   * signal. Walks the derived's `sources` (e.g. "file.bugFixRate", "chunk.bugFixRate"),
   * resolves each to a full payload key, finds the matching PayloadSignalDescriptor,
   * and returns the first non-empty `stats.confidence`. Returns undefined when no
   * source descriptor declares confidence — the derived signal then dampens
   * against its own class `FALLBACK_K`, which is the live situation for six of
   * the eight dampening-aware signals (only `bugFix` and `instability` are
   * declared). The legacy `dampeningSource` path this once fell back to is gone.
   */
  private resolveDerivedConfidence(descriptor: DerivedSignalDescriptor): SignalConfidence | undefined {
    for (const source of descriptor.sources) {
      const fullKey = this.signalKeyMap.get(source);
      if (!fullKey) continue;
      const raw = this.payloadSignals.find((ps) => ps.key === fullKey);
      if (raw?.stats?.confidence) return raw.stats.confidence;
    }
    return undefined;
  }

  /**
   * Look up a collection-level percentile for a source key.
   * Resolves short name → full path via signalKeyMap, then reads from collectionStats.
   * Percentile 5 serves the age-source floor (now − p5(lastModifiedAt)), 95 the
   * generic raw-value bound.
   */
  private getCollectionPercentile(source: string, percentile: number): number | undefined {
    if (!this.collectionStats) return undefined;
    const fullPath = this.signalKeyMap.get(source) ?? source;
    return this.collectionStats.perSignal.get(fullPath)?.percentiles?.[percentile];
  }

  /**
   * Read a raw source value from the payload for adaptive bounds computation.
   * Uses signalKeyMap to resolve short source names (e.g. "ageDays") to full
   * payload paths (e.g. "git.file.ageDays"). Falls back to treating source as
   * a dotted path if no mapping exists.
   */
  private readRawSource(result: RerankableResult, source: string): number | undefined {
    const payload = result.payload ?? {};

    // 1. Try signalKeyMap: shortName -> full dotted path
    const fullPath = this.signalKeyMap.get(source);
    if (fullPath) {
      const val = readPayloadPath(payload, fullPath);
      return typeof val === "number" ? val : undefined;
    }

    // 2. Fallback: source as payload path (dotted or top-level)
    const val = readPayloadPath(payload, source);
    return typeof val === "number" ? val : undefined;
  }

  /**
   * Build ranking overlay for a single result.
   * When mask is present, only include raw signals listed in the mask.
   * When mask is absent (custom weights), include raw sources for all active weight keys.
   * Mask entries naming a query-time age signal (`ageDays`) resolve through the
   * descriptor's `ageDerivation` capability — value = computed age, not the
   * stored stamp (bd tea-rags-mcp-9ot33).
   */
  private buildOverlay(
    result: RerankableResult,
    presetName: string,
    weights: ScoringWeights,
    derivedValues: Record<string, number>,
    mask?: OverlayMask,
    signalLevel?: SignalLevel,
    nowSec?: number,
  ): RankingOverlay {
    const rawFile: Record<string, unknown> = {};
    const rawChunk: Record<string, unknown> = {};
    const skipChunk = signalLevel === "file";

    if (mask) {
      if (mask.file) {
        for (const field of mask.file) {
          this.extractRawSource(result, field, rawFile, rawChunk, nowSec);
        }
      }
      if (mask.chunk && !skipChunk) {
        for (const field of mask.chunk) {
          // A mask entry may be level-RELATIVE (`commitCount`, whose level is
          // the bucket it sits in) or an ABSOLUTE logical key that already names
          // its level (`codegraph.chunk.pageRank`). Only the first kind takes
          // the prefix; prefixing the second builds
          // `chunk.codegraph.chunk.pageRank`, which matches no signalKeyMap
          // entry and no payload path, so the signal drops out of the overlay
          // with no error to notice.
          const source = isLevelQualifiedPayloadKey(field) ? field : `chunk.${field}`;
          this.extractRawSource(result, source, rawFile, rawChunk, nowSec);
        }
      }
    } else {
      // Fallback: weight-based (custom weights) — extract raw sources for each active weight
      for (const key of Object.keys(weights)) {
        const w = weights[key as keyof ScoringWeights];
        if (w === undefined || w === 0) continue;

        const descriptor = this.descriptorMap.get(key);
        if (descriptor) {
          for (const source of descriptor.sources) {
            this.extractRawSource(result, source, rawFile, rawChunk, nowSec);
          }
        }
      }
    }

    // Post-process: resolve labels for numeric signals with stats.labels
    const language = typeof result.payload?.["language"] === "string" ? result.payload["language"] : undefined;
    const chunkType = typeof result.payload?.["chunkType"] === "string" ? result.payload["chunkType"] : undefined;
    const relativePath = typeof result.payload?.["relativePath"] === "string" ? result.payload["relativePath"] : "";

    this.applyLabelResolution(rawFile, "file", result.payload, language, chunkType, relativePath, nowSec);
    this.applyLabelResolution(rawChunk, "chunk", result.payload, language, chunkType, relativePath, nowSec);

    return {
      preset: presetName,
      ...(Object.keys(rawFile).length > 0 ? { file: rawFile } : {}),
      ...(Object.keys(rawChunk).length > 0 ? { chunk: rawChunk } : {}),
    };
  }

  /**
   * Resolve human-readable labels for numeric overlay values.
   * For each entry in the overlay object: if value is a number,
   * find the signal descriptor via signalKeyMap, and if it has
   * stats.labels AND collectionStats has percentile data for that signal,
   * replace the plain number with { value, label }.
   *
   * Age entries (`ageDays`, placed by the `ageDerivation` capability) resolve
   * their bands NOW-RELATIVELY: the thresholds come from the same level's
   * lastModifiedAt stamp percentiles, inverted (age pN ⇔ stamp p(100−N)), so
   * bands keep meaning on points that were never re-enriched
   * (bd tea-rags-mcp-9ot33). Stamp percentiles missing (no backfill yet) →
   * the bare computed number stays, like any signal without stats.
   */
  private applyLabelResolution(
    overlay: Record<string, unknown>,
    level: "file" | "chunk",
    rawPayload: Record<string, unknown> | undefined,
    language?: string,
    chunkType?: string,
    relativePath?: string,
    nowSec?: number,
  ): void {
    if (!this.collectionStats) return;

    // Read sibling values from RAW PAYLOAD at this scope, NOT from the projected
    // overlay. The overlay is mask-filtered — fields not in the preset's mask
    // (e.g. commitCount absent from HotspotsPreset.overlayMask.file) would
    // otherwise be invisible to the resolver, breaking confidence clamp for any
    // signal whose support sibling isn't independently surfaced. Raw payload is
    // the unfiltered source of truth at each scope.
    const siblingValues = this.collectScopeSiblings(rawPayload, level);

    for (const field of Object.keys(overlay)) {
      const value = overlay[field];
      if (typeof value !== "number") continue;

      // Resolve full payload key from short name, preferring level-specific key
      const fullKey = this.signalKeyMap.get(`${level}.${field}`) ?? this.signalKeyMap.get(field) ?? null;
      if (!fullKey) continue;

      // Find descriptor with stats.labels
      const descriptor = this.payloadSignals.find((ps) => ps.key === fullKey);
      if (!descriptor?.stats?.labels) continue;

      // Age branch: label bands derive from the timestamp stats, inverted at
      // query time — not from the ageDays stamp's own (frozen) percentiles.
      const age = this.ageCapabilities().get(`${level}.${field}`);
      if (age && nowSec !== undefined) {
        const stampKey = this.signalKeyMap.get(`${level}.${age.cap.timestampField}`);
        const stampStats = this.scopedStatsFor(stampKey, language, chunkType, relativePath);
        if (!stampStats) continue;
        const bands = age.cap.labelThresholdsFromStamps(stampStats.percentiles, nowSec);
        const resolvedConfidence = this.preResolveConfidenceClamp(descriptor.stats.confidence, level);
        const label = resolveLabel(value, descriptor.stats.labels, bands, {
          siblingValues,
          confidence: resolvedConfidence,
        });
        overlay[field] = { value, label };
        continue;
      }

      // Labels only for code languages present in perLanguage — no global fallback.
      if (!language) continue;
      const signalStats = this.scopedStatsFor(fullKey, language, chunkType, relativePath);
      if (!signalStats?.percentiles) continue;

      // Industry floors raise source-scope thresholds that sit below a
      // published limit; test scope stays purely percentile-derived, since
      // test files are systematically longer and a shared floor would collapse
      // most of them into the top label.
      const percentiles =
        detectScope(chunkType, relativePath ?? "", language, {
          languageTestChunkCounts: new Map(),
        }) === "test"
          ? signalStats.percentiles
          : applySignalFloors(
              signalStats.percentiles,
              descriptor.stats.labels,
              floorsForSignal(this.signalFloors, language, fullKey),
            );

      const resolvedConfidence = this.preResolveConfidenceClamp(descriptor.stats.confidence, level);
      const label = resolveLabel(value, descriptor.stats.labels, percentiles, {
        siblingValues,
        confidence: resolvedConfidence,
        bandTieBreak: descriptor.stats.bandTieBreak,
      });
      overlay[field] = { value, label };
    }
  }

  /**
   * Per-language, scope-split stats for one signal key, with the source/test
   * pick and the no-global-fallback rule applied. Shared by the generic label
   * path and the age branch so both read stats identically.
   */
  private scopedStatsFor(
    fullKey: string | undefined,
    language: string | undefined,
    chunkType: string | undefined,
    relativePath?: string,
  ): { percentiles: Record<number, number> } | undefined {
    if (!this.collectionStats || !language) return undefined;
    const langStats = this.collectionStats.perLanguage?.get(language);
    if (!langStats) return undefined;
    if (!fullKey) return undefined;
    const scopedStats = langStats.get(fullKey);
    if (!scopedStats) return undefined;
    const scope = detectScope(chunkType, relativePath ?? "", language, {
      languageTestChunkCounts: new Map(),
    });
    const signalStats = scope === "test" && scopedStats.test ? scopedStats.test : scopedStats.source;
    return signalStats?.percentiles ? signalStats : undefined;
  }

  /**
   * Overlay stamp-field → age capability, keyed `<level>.<stampField>` and
   * `<level>.<timestampField>`. Built lazily from the injected descriptors —
   * only age-family signals carry the capability, so a mask entry (or a custom
   * weight's source) naming one of these keys resolves its overlay value and
   * label bands through the derivation unit instead of the stored stamp.
   */
  private ageCapabilities(): Map<string, { cap: AgeDerivationCapability; level: "file" | "chunk" }> {
    if (!this.ageCapabilityMap) {
      this.ageCapabilityMap = new Map();
      for (const d of this.descriptors) {
        const cap = d.ageDerivation;
        if (!cap) continue;
        for (const level of ["file", "chunk"] as const) {
          this.ageCapabilityMap.set(`${level}.${cap.stampField}`, { cap, level });
          this.ageCapabilityMap.set(`${level}.${cap.timestampField}`, { cap, level });
        }
      }
    }
    return this.ageCapabilityMap;
  }

  /**
   * Build a sibling-values map from the RAW payload at a given scope.
   * Handles all trajectory payload shapes:
   *   • Git nested:        payload.git.{scope}.{signalName}              (bare keys)
   *   • Git flat:          payload["git.{scope}.{signalName}"]           (Qdrant flattened)
   *   • Codegraph nested:  payload.codegraph.symbols.{scope}.{signalName} (bare keys, k6xu)
   *   • Codegraph flat:    payload["codegraph.{scope}.{signalName}"]
   * Returns bare-name keys (`commitCount`, `connectionCount`, not the
   * fully-qualified payload key) so `SignalConfidence.support` resolves
   * directly via same-scope lookup, regardless of which trajectory owns
   * the support sibling. Codegraph's nested form (tea-rags-mcp-0am0) was
   * invisible before that fix because EnrichmentApplier writes signals under
   * providerKey `codegraph.symbols`; inner keys are now BARE (tea-rags-mcp-k6xu),
   * mirroring git's nested shape.
   */
  private collectScopeSiblings(
    rawPayload: Record<string, unknown> | undefined,
    scope: "file" | "chunk",
  ): Record<string, number> {
    if (!rawPayload) return {};
    const out: Record<string, number> = {};

    // Git nested format: payload.git.{file,chunk}.{signalName}
    const { git } = rawPayload as { git?: unknown };
    if (git && typeof git === "object") {
      const scoped = (git as Record<string, unknown>)[scope];
      if (scoped && typeof scoped === "object") {
        for (const [k, v] of Object.entries(scoped as Record<string, unknown>)) {
          if (typeof v === "number") out[k] = v;
        }
      }
    }

    // Codegraph nested format: payload.codegraph.symbols.{scope}.<bareKey>
    // (tea-rags-mcp-k6xu — inner keys are bare, like git's nested shape).
    const { codegraph } = rawPayload as { codegraph?: unknown };
    if (codegraph && typeof codegraph === "object") {
      const { symbols } = codegraph as Record<string, unknown>;
      if (symbols && typeof symbols === "object") {
        const scoped = (symbols as Record<string, unknown>)[scope];
        if (scoped && typeof scoped === "object") {
          for (const [k, v] of Object.entries(scoped as Record<string, unknown>)) {
            if (typeof v !== "number") continue;
            if (!(k in out)) out[k] = v;
          }
        }
      }
    }

    // Flat-format fallback for both trajectories:
    //   payload["git.{scope}.{name}"] / payload["codegraph.{scope}.{name}"]
    const gitPrefix = `git.${scope}.`;
    const cgFlatPrefix = `codegraph.${scope}.`;
    for (const [k, v] of Object.entries(rawPayload)) {
      if (typeof v !== "number") continue;
      const bare = k.startsWith(gitPrefix)
        ? k.slice(gitPrefix.length)
        : k.startsWith(cgFlatPrefix)
          ? k.slice(cgFlatPrefix.length)
          : undefined;
      if (bare !== undefined && !(bare in out)) out[bare] = v;
    }

    return out;
  }

  /**
   * Pre-resolve adaptive `whenSupportAtOrBelow` percentile strings to concrete numbers.
   *
   * When a clamp rule has `whenSupportAtOrBelow: "pN"`, looks up the Nth percentile of
   * `git.{scope}.{confidence.support}` in collection stats. Falls back to
   * `rule.fallback` if collection stats absent OR the support signal has no
   * recorded percentile. Returns the descriptor's confidence with rules normalized
   * to numeric thresholds — resolveLabel sees a clean numeric shape regardless
   * of source.
   */
  private preResolveConfidenceClamp(
    confidence: SignalConfidence | undefined,
    scope: "file" | "chunk",
  ): SignalConfidence | undefined {
    if (!confidence?.label) return confidence;
    const supportFullKey = this.signalKeyMap.get(`${scope}.${confidence.support}`);
    const supportStats = supportFullKey ? this.collectionStats?.perSignal.get(supportFullKey) : undefined;
    const resolvedRules = confidence.label.rules.map((rule) => {
      if (typeof rule.whenSupportAtOrBelow === "number") return rule;
      const pct = Number(rule.whenSupportAtOrBelow.slice(1));
      const adaptive = supportStats?.percentiles?.[pct];
      const threshold = adaptive ?? rule.fallback;
      if (threshold === undefined) {
        // No adaptive and no fallback — rule cannot fire safely. 0 is the
        // narrowest sentinel available: the comparison is inclusive, so this
        // still matches a support of exactly 0 (a real value —
        // `git.*.commitCount` publishes 0 for chunks past chunkMaxFileLines),
        // and nothing above it. Descriptors are required to carry `fallback`
        // precisely so this path stays unreachable.
        return { ...rule, whenSupportAtOrBelow: 0 };
      }
      return { ...rule, whenSupportAtOrBelow: threshold };
    });
    return {
      ...confidence,
      label: { rules: resolvedRules },
    };
  }

  /**
   * Extract a raw source value from payload into the correct level (file/chunk).
   * Uses signalKeyMap to resolve short source names to full payload paths.
   * Determines file vs chunk level from the resolved path (paths containing
   * ".chunk." go to rawChunk, everything else to rawFile).
   *
   * Age paths (`<level>.ageDays` mask entries, `<level>.lastModifiedAt`
   * custom-weight sources) resolve through the age capability: the overlay
   * carries the QUERY-TIME computed age under the stamp key, and drops the
   * field entirely when the point has no stamp — absence still means "no
   * data", not 0 (bd tea-rags-mcp-9ot33).
   */
  private extractRawSource(
    result: RerankableResult,
    source: string,
    rawFile: Record<string, unknown>,
    rawChunk: Record<string, unknown>,
    nowSec?: number,
  ): void {
    const payload = result.payload ?? {};

    // Resolve full path via signalKeyMap or use source as-is
    const fullPath = this.signalKeyMap.get(source) ?? source;
    const age = this.ageCapabilities().get(ageCapabilityKeyFor(fullPath));
    if (age && nowSec !== undefined) {
      const value = age.cap.ageDaysFrom(payload, age.level, nowSec);
      if (value === undefined) return;
      const target = age.level === "chunk" ? rawChunk : rawFile;
      target[age.cap.stampField] = value;
      return;
    }

    const val = readPayloadPath(payload, fullPath);
    if (val === undefined) return;

    const segments = fullPath.split(".");
    const field = segments[segments.length - 1];
    if (fullPath.includes(".chunk.")) {
      rawChunk[field] = val;
    } else {
      rawFile[field] = val;
    }
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Map a resolved full payload path onto its age-capability lookup key —
 * `git.file.ageDays` / `git.file.lastModifiedAt` → `file.ageDays` /
 * `file.lastModifiedAt`. Anything the age family does not own comes back
 * unchanged and misses the capability map.
 */
function ageCapabilityKeyFor(fullPath: string): string {
  const m = /(?:^|\.)(file|chunk)\.(ageDays|lastModifiedAt)$/.exec(fullPath);
  return m ? `${m[1]}.${m[2]}` : fullPath;
}

/**
 * Calculate final score based on weights and signals
 */
/** Min/max of the finite raw scores in a result batch, or undefined if none. */
function computeScoreRange(results: RerankableResult[]): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  let seen = false;
  for (const r of results) {
    if (typeof r.score === "number" && Number.isFinite(r.score)) {
      seen = true;
      if (r.score < min) min = r.score;
      if (r.score > max) max = r.score;
    }
  }
  return seen ? { min, max } : undefined;
}

/**
 * Min-max normalize a raw score into [0,1] over the batch range. Scale-free:
 * works identically for cosine and RRF scores, so the similarity weight has the
 * same meaning across tools. A degenerate batch (max === min, e.g. rank_chunks'
 * constant scores) maps to 1.0 for every result — order-preserving, no NaN.
 * A non-finite score with no batch range passes through unchanged (the
 * similarity signal then falls back to 0).
 */
function normalizeSimilarityScore(score: number, range: { min: number; max: number } | undefined): number {
  if (!range || typeof score !== "number" || !Number.isFinite(score)) return score;
  if (range.max <= range.min) return 1.0;
  return (score - range.min) / (range.max - range.min);
}

function calculateScore(signals: Record<string, number>, weights: ScoringWeights): number {
  let score = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    if (typeof weight === "number" && weight !== 0 && key in signals) {
      const signalValue = signals[key];
      if (typeof signalValue === "number") {
        score += signalValue * weight;
        totalWeight += Math.abs(weight);
      }
    }
  }

  // Normalize by total weight to keep score in 0-1 range
  return totalWeight > 0 ? score / totalWeight : signals.similarity || 0;
}

// ---------------------------------------------------------------------------
// Payload path utilities
// ---------------------------------------------------------------------------

/**
 * Traverse a nested payload using dot-notation path. Delegates to the shared
 * {@link resolvePayloadValue} so the score/overlay paths address codegraph's
 * nested-symbols shape (`codegraph.symbols.file.fanIn`) identically to the
 * collection-stats accumulator — one resolver, no duplicated regex.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  return resolvePayloadValue(payload, path);
}

/**
 * Build a mapping from short source names (as used in DerivedSignalDescriptor.sources
 * and OverlayMask) to full payload dot-notation paths.
 *
 * For each PayloadSignalDescriptor with key "git.file.ageDays", generates suffix keys:
 *   - "ageDays"       -> "git.file.ageDays"  (1-segment suffix, set only if not already taken)
 *   - "file.ageDays"  -> "git.file.ageDays"  (2-segment suffix, always set)
 *
 * For "git.chunk.commitCount":
 *   - "commitCount"         -> "git.chunk.commitCount" (only if not already taken by file-level)
 *   - "chunk.commitCount"   -> "git.chunk.commitCount" (always set, this is the canonical form)
 *
 * This ensures that descriptor sources like "ageDays" resolve to file-level and
 * "chunk.commitCount" resolves to chunk-level, matching the existing convention.
 *
 * A DOTLESS key maps onto itself:
 *   - "moduleLines" -> "moduleLines"
 *
 * That case is the whole reason the loop starts at the full segment count —
 * see the comment on the loop.
 */
export function buildSignalKeyMap(payloadSignals: PayloadSignalDescriptor[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const ps of payloadSignals) {
    const segments = ps.key.split(".");
    // Generate suffix keys from the FULL key down to the 1-segment suffix.
    // Starting at `segments.length` rather than `segments.length - 1` is what
    // admits DOTLESS keys (bd tea-rags-mcp-u64tm): a key like "moduleLines"
    // has one segment, so the old bound started the loop at 0 and it never
    // ran — the signal was absent from the map and `applyLabelResolution`
    // dropped it at `if (!fullKey) continue`, leaving every top-level static
    // signal (moduleLines, moduleMethodCount, memberCount, methodLines,
    // methodDensity) as a bare number in the overlay. For a dotted key the
    // extra iteration maps the full key onto itself, which is a no-op in
    // practice and keeps the suffix forms below unchanged.
    for (let len = segments.length; len >= 1; len--) {
      const suffix = segments.slice(segments.length - len).join(".");
      if (len === 1) {
        // 1-segment suffix: only set if not already taken (avoids file/chunk collision)
        if (!map.has(suffix)) {
          map.set(suffix, ps.key);
        }
      } else {
        // Multi-segment suffix: always set (canonical form like "chunk.commitCount")
        map.set(suffix, ps.key);
      }
    }
  }

  return map;
}

/**
 * Returns true when the only non-zero weight is `similarity`. Used as a fast
 * path in `rerank()` to skip adaptive bounds + overlay computation.
 *
 * @internal Exported only for unit testing. Not part of the public module API.
 */
export function isSimilarityOnly(weights: ScoringWeights): boolean {
  const activeKeys = Object.keys(weights).filter((k) => {
    const w = weights[k as keyof ScoringWeights];
    return w !== undefined && w !== 0;
  });
  return activeKeys.length === 1 && activeKeys[0] === "similarity";
}

/**
 * Collapse sorted results by payload field, keeping the first (highest-scored)
 * entry per group. Missing/empty group keys each get a unique `__ungrouped_N`
 * slot so they don't collapse into a single bucket.
 *
 * @internal Exported only for unit testing. Not part of the public module API.
 */
export function groupByTop<T extends { payload?: Record<string, unknown> }>(sorted: T[], groupBy: string): T[] {
  const seen = new Map<string, T>();
  for (const r of sorted) {
    const raw = r.payload?.[groupBy];
    const key = typeof raw === "string" ? raw : "";
    if (!key || !seen.has(key)) {
      seen.set(key || `__ungrouped_${seen.size}`, r);
    }
  }
  return [...seen.values()];
}
