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
import type { CollectionSignalStats, PayloadSignalDescriptor } from "../../contracts/types/trajectory.js";
import { p95 } from "../../infra/signal-utils.js";
import { resolveLabel } from "./label-resolver.js";

// Re-export types as part of search module's public API
export type { ScoringWeights } from "../../contracts/types/provider.js";
export type { RerankableResult, RerankMode } from "../../contracts/types/reranker.js";

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
  setCollectionStats(stats: CollectionSignalStats): void {
    this.collectionStats = stats;
  }

  /** Invalidate stats (called when reindex starts). */
  invalidateStats(): void {
    this.collectionStats = undefined;
  }

  /**
   * Rerank results with ranking overlay.
   */
  rerank<T extends RerankableResult>(
    results: T[],
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code" | "rank_chunks",
    overrideSignalLevel?: SignalLevel,
  ): (T & { rankingOverlay?: RankingOverlay })[] {
    // Resolve weights, overlay mask, groupBy, and signalLevel
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
      // Custom weights with preset overlay mask (used by rank_chunks)
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

    // User override wins over preset signalLevel
    if (overrideSignalLevel) signalLevel = overrideSignalLevel;

    // Fast path: similarity-only -> no reranking, no overlay
    const activeKeys = Object.keys(weights).filter((k) => {
      const w = weights[k as keyof ScoringWeights];
      return w !== undefined && w !== 0;
    });
    if (activeKeys.length === 1 && activeKeys[0] === "similarity") {
      return results.map((r) => ({ ...r }));
    }

    // Compute adaptive bounds from result batch
    const bounds = this.computeAdaptiveBounds(results);

    // Score each result and attach overlay
    const scored = results.map((result) => {
      const payload = this.buildExtractPayload(result);
      const signals = this.extractAllDerived(payload, bounds, signalLevel);
      const score = calculateScore(signals, weights);
      const overlay = this.buildOverlay(result, presetName, weights, signals, mask, signalLevel);
      return { ...result, score, rankingOverlay: overlay };
    });

    const sorted = scored.sort((a, b) => b.score - a.score);

    // Group by payload field: keep highest-scored (first) per group
    if (groupBy) {
      const seen = new Map<string, (typeof sorted)[number]>();
      for (const r of sorted) {
        const raw = r.payload?.[groupBy];
        const key = typeof raw === "string" ? raw : "";
        if (!key || !seen.has(key)) {
          seen.set(key || `__ungrouped_${seen.size}`, r);
        }
      }
      return [...seen.values()];
    }

    return sorted;
  }

  /**
   * Get preset weights for a specific preset name and tool.
   */
  getPreset(name: string, tool: "semantic_search" | "search_code" | "rank_chunks"): ScoringWeights | undefined {
    return this.resolvedPresets.find((p) => p.name === name && this.matchesTool(p, tool))?.weights;
  }

  /**
   * Get full preset object for a specific preset name and tool.
   */
  getFullPreset(name: string, tool: "semantic_search" | "search_code" | "rank_chunks"): RerankPreset | undefined {
    return this.resolvedPresets.find((p) => p.name === name && this.matchesTool(p, tool));
  }

  /**
   * Get available preset names for a tool.
   */
  getAvailablePresets(tool: "semantic_search" | "search_code" | "rank_chunks"): string[] {
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
  private buildExtractPayload(result: RerankableResult): Record<string, unknown> {
    return { _score: result.score, ...(result.payload ?? {}) };
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
      signals[d.name] = d.extract(payload, {
        bounds,
        dampeningThreshold,
        collectionStats: this.collectionStats,
        signalLevel,
      });
    }

    return signals;
  }

  /**
   * Resolve dampening threshold for a specific descriptor from its dampeningSource.
   * Returns undefined if descriptor has no dampeningSource or collectionStats is not loaded —
   * derived signals fall back to their per-signal FALLBACK_THRESHOLD.
   */
  private resolveDampeningThreshold(descriptor: DerivedSignalDescriptor): number | undefined {
    if (!this.collectionStats || !descriptor.dampeningSource) return undefined;
    const { key, percentile } = descriptor.dampeningSource;
    const stats = this.collectionStats.perSignal.get(key);
    return stats?.percentiles?.[percentile];
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

    this.applyLabelResolution(rawFile, "file", language);
    this.applyLabelResolution(rawChunk, "chunk", language);

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
  private applyLabelResolution(overlay: Record<string, unknown>, level: "file" | "chunk", language?: string): void {
    if (!this.collectionStats) return;

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
      // Config languages and unknown languages get raw numbers without labels.
      if (!language) continue;
      const langStats = this.collectionStats.perLanguage?.get(language);
      if (!langStats) continue;
      const signalStats = langStats.get(fullKey);
      if (!signalStats?.percentiles) continue;

      const label = resolveLabel(value, descriptor.stats.labels, signalStats.percentiles);
      overlay[field] = { value, label };
    }
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
 * Traverse a nested payload using dot-notation path.
 * E.g. readPayloadPath(payload, "git.file.ageDays") walks payload.git.file.ageDays.
 */
function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = payload;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
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
