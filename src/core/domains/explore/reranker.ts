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

import { p95, resolvePayloadValue } from "../../contracts/signal-utils.js";
import type { ScoringWeights } from "../../contracts/types/provider.js";
import type {
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
} from "../../contracts/types/trajectory.js";
import { detectScope } from "../../infra/scope-detection.js";
import type { StatsRecomputeService } from "../ingest/infra/stats-recompute.js";
import { resolveLabel } from "./label-resolver.js";

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
  private payloadFieldKeys?: string[];
  private recomputeService?: StatsRecomputeService;

  constructor(
    private readonly descriptors: DerivedSignalDescriptor[],
    private readonly resolvedPresets: RerankPreset[],
    payloadSignals: PayloadSignalDescriptor[] = [],
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

  /** Set collection-wide signal stats (computed after indexing). */
  setCollectionStats(
    stats: CollectionSignalStats,
    opts?: { collectionName?: string; payloadFieldKeys?: string[] },
  ): void {
    this.collectionStats = stats;
    this.collectionName = opts?.collectionName;
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
    this.payloadFieldKeys = undefined;
  }

  /**
   * Rerank results with ranking overlay.
   *
   * Lazy-at-rerank: BEFORE scoring, walks every confidence reference declared
   * by payload signals (score `adaptivePercentile`, label rule `whenSupportBelow: "pN"`)
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
    const bounds = this.computeAdaptiveBounds(results);
    const scored = this.scoreResults(results, bounds, resolved, options?.query);
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
  ): (T & { score: number; rankingOverlay?: RankingOverlay })[] {
    // Batch min-max range of the raw vector score. The similarity signal reads a
    // normalized score so preset weights mean the same thing whether the score
    // came from cosine (semantic_search, ~0.5-0.85 narrow) or RRF fusion
    // (hybrid_search, rank-shaped/hyperbolic). Reached only past the
    // isSimilarityOnly fast path, so similarity-only ranking is untouched.
    const scoreRange = computeScoreRange(results);
    return results.map((result) => {
      const payload = this.buildExtractPayload(result, normalizeSimilarityScore(result.score, scoreRange));
      const signals = this.extractAllDerived(payload, bounds, resolved.signalLevel, query);
      const score = calculateScore(signals, resolved.weights);
      const overlay = this.buildOverlay(
        result,
        resolved.presetName,
        resolved.weights,
        signals,
        resolved.mask,
        resolved.signalLevel,
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
   * Returns Map<sourceKey, adaptiveBound>.
   */
  private computeAdaptiveBounds(results: RerankableResult[]): Map<string, number> {
    const rawValues = new Map<string, number[]>();

    for (const result of results) {
      for (const d of this.descriptors) {
        if (d.defaultBound === undefined) continue;
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
      const collectionP95 = this.getCollectionP95(source);
      sourceBounds.set(source, Math.max(batchP95, collectionP95 ?? 0));
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
      });
    }

    return signals;
  }

  /**
   * Resolve ADAPTIVE dampening threshold for a derived signal from collection stats.
   *
   * Reads `stats.confidence.support` (the support sibling name) from the raw
   * payload descriptor and looks up its `adaptivePercentile` (default 25) in
   * `git.file.{support}` collection stats. Returns undefined when collection
   * stats are absent OR no confidence block is declared — derived signals then
   * fall back to `confidence.score.threshold` (descriptor floor) or their own
   * defensive constant.
   *
   * The static floor is intentionally a last resort — adaptive takes priority
   * so the dampening threshold scales with the actual codebase's commit
   * distribution.
   */
  private resolveDampeningThreshold(descriptor: DerivedSignalDescriptor): number | undefined {
    return this.resolveDampeningThresholdForScope(descriptor, "file");
  }

  /**
   * Resolve the CHUNK-scope adaptive dampening threshold (k_c) — the chunk
   * support signal's `adaptivePercentile`. Mirrors {@link resolveDampeningThreshold}
   * but reads `chunk.{support}` collection stats, so blended signals can dampen
   * their chunk component by its own sample size. Returns undefined when the
   * chunk support percentile isn't available (e.g. file-only support).
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
    return stats?.percentiles?.[percentile];
  }

  /**
   * Look up the raw payload descriptor's `stats.confidence` block for a derived
   * signal. Walks the derived's `sources` (e.g. "file.bugFixRate", "chunk.bugFixRate"),
   * resolves each to a full payload key, finds the matching PayloadSignalDescriptor,
   * and returns the first non-empty `stats.confidence`. Returns undefined when no
   * source descriptor declares confidence — derived signal then falls back to
   * legacy `dampeningSource`/`FALLBACK_THRESHOLD` path during migration.
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
   * Look up collection-level p95 for a source key.
   * Resolves short name → full path via signalKeyMap, then reads from collectionStats.
   */
  private getCollectionP95(source: string): number | undefined {
    if (!this.collectionStats) return undefined;
    const fullPath = this.signalKeyMap.get(source) ?? source;
    return this.collectionStats.perSignal.get(fullPath)?.percentiles?.[95];
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
   */
  private buildOverlay(
    result: RerankableResult,
    presetName: string,
    weights: ScoringWeights,
    derivedValues: Record<string, number>,
    mask?: OverlayMask,
    signalLevel?: SignalLevel,
  ): RankingOverlay {
    const rawFile: Record<string, unknown> = {};
    const rawChunk: Record<string, unknown> = {};
    const skipChunk = signalLevel === "file";

    if (mask) {
      if (mask.file) {
        for (const field of mask.file) {
          this.extractRawSource(result, field, rawFile, rawChunk);
        }
      }
      if (mask.chunk && !skipChunk) {
        for (const field of mask.chunk) {
          this.extractRawSource(result, `chunk.${field}`, rawFile, rawChunk);
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
            this.extractRawSource(result, source, rawFile, rawChunk);
          }
        }
      }
    }

    // Post-process: resolve labels for numeric signals with stats.labels
    const language = typeof result.payload?.["language"] === "string" ? result.payload["language"] : undefined;
    const chunkType = typeof result.payload?.["chunkType"] === "string" ? result.payload["chunkType"] : undefined;
    const relativePath = typeof result.payload?.["relativePath"] === "string" ? result.payload["relativePath"] : "";

    this.applyLabelResolution(rawFile, "file", result.payload, language, chunkType, relativePath);
    this.applyLabelResolution(rawChunk, "chunk", result.payload, language, chunkType, relativePath);

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
   */
  private applyLabelResolution(
    overlay: Record<string, unknown>,
    level: "file" | "chunk",
    rawPayload: Record<string, unknown> | undefined,
    language?: string,
    chunkType?: string,
    relativePath?: string,
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

      // Labels only for code languages present in perLanguage — no global fallback.
      if (!language) continue;
      const langStats = this.collectionStats.perLanguage?.get(language);
      if (!langStats) continue;
      const scopedStats = langStats.get(fullKey);
      if (!scopedStats) continue;

      // Scope-aware: use test thresholds for test chunks, source for everything else
      const scope = detectScope(chunkType, relativePath ?? "", language, {
        languageTestChunkCounts: new Map(),
      });
      const signalStats = scope === "test" && scopedStats.test ? scopedStats.test : scopedStats.source;
      if (!signalStats?.percentiles) continue;

      const resolvedConfidence = this.preResolveConfidenceClamp(descriptor.stats.confidence, level);
      const label = resolveLabel(value, descriptor.stats.labels, signalStats.percentiles, {
        siblingValues,
        confidence: resolvedConfidence,
      });
      overlay[field] = { value, label };
    }
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
   * Pre-resolve adaptive `whenSupportBelow` percentile strings to concrete numbers.
   *
   * When a clamp rule has `whenSupportBelow: "pN"`, looks up the Nth percentile of
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
      if (typeof rule.whenSupportBelow === "number") return rule;
      const pct = Number(rule.whenSupportBelow.slice(1));
      const adaptive = supportStats?.percentiles?.[pct];
      const threshold = adaptive ?? rule.fallback;
      if (threshold === undefined) {
        // No adaptive and no fallback — rule cannot fire safely. Use 0 as a
        // never-matches sentinel (support < 0 is structurally impossible).
        return { ...rule, whenSupportBelow: 0 };
      }
      return { ...rule, whenSupportBelow: threshold };
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
   */
  private extractRawSource(
    result: RerankableResult,
    source: string,
    rawFile: Record<string, unknown>,
    rawChunk: Record<string, unknown>,
  ): void {
    const payload = result.payload ?? {};

    // Resolve full path via signalKeyMap or use source as-is
    const fullPath = this.signalKeyMap.get(source) ?? source;
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
 */
function buildSignalKeyMap(payloadSignals: PayloadSignalDescriptor[]): Map<string, string> {
  const map = new Map<string, string>();

  for (const ps of payloadSignals) {
    const segments = ps.key.split(".");
    // Generate suffix keys from longest (N-1 segments) to shortest (1 segment)
    for (let len = segments.length - 1; len >= 1; len--) {
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
