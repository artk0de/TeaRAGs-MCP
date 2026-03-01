/**
 * Reranker module for search result scoring
 *
 * Descriptor-based scoring: each DerivedSignalDescriptor knows how to
 * extract its normalized value from the payload. The Reranker:
 * 1. Computes adaptive bounds (p95 from batch, floored with descriptor.defaultBound)
 * 2. Calls descriptor.extract(payload, adaptiveBound) for each signal
 * 3. Applies confidence dampening (needsConfidence + confidenceField)
 * 4. Computes weighted sum score
 * 5. Attaches ranking overlay (raw file/chunk signals for transparency)
 */

import { p95 } from "../contracts/signal-utils.js";
import type { ScoringWeights } from "../contracts/types/provider.js";
import type {
  DerivedSignalDescriptor,
  OverlayMask,
  RankingOverlay,
  RerankableResult,
  RerankMode,
  RerankPreset,
} from "../contracts/types/reranker.js";

// Re-export types from contracts for backward compatibility
export type { ScoringWeights } from "../contracts/types/provider.js";
export type { RerankableResult, RerankMode } from "../contracts/types/reranker.js";

// ---------------------------------------------------------------------------
// Scoring utilities
// ---------------------------------------------------------------------------

/**
 * Per-signal confidence thresholds.
 * Signals derived from binary proportions (bugFixRate, churnVolatility)
 * need more samples to be statistically meaningful than simple counts.
 */
const CONFIDENCE_THRESHOLDS: Partial<Record<string, number>> = {
  bugFix: 8,
  volatility: 8,
  ownership: 5,
  knowledgeSilo: 5,
  density: 5,
  relativeChurnNorm: 5,
};
const DEFAULT_CONFIDENCE_THRESHOLD = 5;
const CONFIDENCE_POWER = 2;

/**
 * Quadratic confidence dampening for a given signal.
 * Returns 1 when effectiveCommitCount >= threshold, otherwise (n/k)^p.
 */
export function signalConfidence(effectiveCommitCount: number, signal: string): number {
  const k = CONFIDENCE_THRESHOLDS[signal] ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (effectiveCommitCount >= k) return 1;
  return Math.pow(effectiveCommitCount / k, CONFIDENCE_POWER);
}

// ---------------------------------------------------------------------------
// Reranker — descriptor-based scoring with ranking overlay
// ---------------------------------------------------------------------------

/**
 * Reranker — descriptor-based scoring with ranking overlay.
 *
 * Uses DerivedSignalDescriptor.extract() for all signal extraction.
 * Applies adaptive bounds (p95 from result batch, floored with defaultBound).
 * Applies confidence dampening for signals with needsConfidence=true.
 * Attaches RankingOverlay to explain WHY each result scored the way it did.
 */
export class Reranker {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;

  constructor(
    private readonly descriptors: DerivedSignalDescriptor[],
    private readonly resolvedPresets: RerankPreset[],
  ) {
    this.descriptorMap = new Map();
    for (const d of this.descriptors) {
      this.descriptorMap.set(d.name, d);
    }
  }

  /**
   * Rerank results with ranking overlay.
   */
  rerank<T extends RerankableResult>(
    results: T[],
    mode: RerankMode<string>,
    presetSet: "semantic_search" | "search_code",
  ): (T & { rankingOverlay?: RankingOverlay })[] {
    // Resolve weights and overlay mask
    let weights: ScoringWeights;
    let presetName: string;
    let mask: OverlayMask | undefined;
    if (typeof mode === "string") {
      presetName = mode;
      const fullPreset = this.resolvedPresets.find((p) => p.name === mode && this.matchesTool(p, presetSet));
      weights = fullPreset?.weights ?? { similarity: 1.0 };
      mask = fullPreset?.overlayMask;
    } else {
      presetName = "custom";
      weights = mode.custom;
    }

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
      const signals = this.extractAllDerived(payload, bounds);
      const score = calculateScore(signals, weights);
      const overlay = this.buildOverlay(result, presetName, weights, signals, mask);
      return { ...result, score, rankingOverlay: overlay };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Get preset weights for a specific preset name and tool.
   */
  getPreset(name: string, tool: "semantic_search" | "search_code"): ScoringWeights | undefined {
    return this.resolvedPresets.find((p) => p.name === name && this.matchesTool(p, tool))?.weights;
  }

  /**
   * Get available preset names for a tool.
   */
  getAvailablePresets(tool: "semantic_search" | "search_code"): string[] {
    return this.resolvedPresets.filter((p) => this.matchesTool(p, tool)).map((p) => p.name);
  }

  /** Descriptor info for MCP schema generation. */
  getDescriptorInfo(): { name: string; description: string }[] {
    return this.descriptors.map((d) => ({ name: d.name, description: d.description }));
  }

  /** Preset names for a specific tool. */
  getPresetNames(tool: string): string[] {
    return this.resolvedPresets.filter((p) => this.matchesTool(p, tool)).map((p) => p.name);
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
   * Compute adaptive bounds from the result batch.
   * For each descriptor with defaultBound, read raw source values from the payload,
   * compute p95, and floor with defaultBound.
   * Returns Map<descriptorName, adaptiveBound>.
   */
  private computeAdaptiveBounds(results: RerankableResult[]): Map<string, number> {
    const bounds = new Map<string, number>();
    const rawValues = new Map<string, number[]>();

    for (const result of results) {
      for (const d of this.descriptors) {
        if (d.defaultBound === undefined) continue;
        if (d.sources.length === 0) continue; // Structural signals use static bounds

        // Read raw values from the first source (each bounded descriptor has one primary source)
        const source = d.sources[0];
        const raw = this.readRawSource(result, source);
        if (raw !== undefined && raw > 0) {
          let arr = rawValues.get(d.name);
          if (!arr) {
            arr = [];
            rawValues.set(d.name, arr);
          }
          arr.push(raw);
        }
      }
    }

    for (const [name, values] of rawValues) {
      const d = this.descriptorMap.get(name);
      if (!d) continue;
      const p95Val = p95(values);
      bounds.set(name, Math.max(p95Val, d.defaultBound ?? 1));
    }

    return bounds;
  }

  /**
   * Extract all derived signal values from a payload.
   * Calls descriptor.extract(payload, adaptiveBound) for each signal.
   * Applies confidence dampening for signals with needsConfidence.
   */
  private extractAllDerived(payload: Record<string, unknown>, bounds: Map<string, number>): Record<string, number> {
    const signals: Record<string, number> = {};

    for (const d of this.descriptors) {
      const bound = bounds.get(d.name);
      let value = d.extract(payload, bound);

      // Confidence dampening: quadratic per-signal
      if (d.needsConfidence) {
        const confidenceValue = this.getEffectiveConfidenceValue(payload, d.confidenceField ?? "commitCount");
        value *= signalConfidence(confidenceValue, d.name);
      }

      signals[d.name] = value;
    }

    return signals;
  }

  /**
   * Get the effective confidence value (blended file+chunk commit count).
   * Matches monolith's effectiveCommitCount = effectiveSignal(chunk.commitCount, file.commitCount, alpha).
   */
  private getEffectiveConfidenceValue(payload: Record<string, unknown>, field: string): number {
    const git = payload.git as Record<string, unknown> | undefined;
    if (!git) return 0;

    // File-level value (nested then flat)
    const file = git.file as Record<string, unknown> | undefined;
    const fileVal = (file?.[field] as number) ?? (git[field] as number) ?? 0;

    // Chunk-level for blending
    const chunk = git.chunk as Record<string, unknown> | undefined;
    const chunkVal = chunk?.[field] as number | undefined;
    if (chunkVal === undefined || chunkVal <= 0) return fileVal;

    // Compute alpha for blending
    const fileCC = (file?.commitCount as number) ?? (git.commitCount as number) ?? 0;
    const chunkCC = (chunk?.commitCount as number) ?? 0;
    if (fileCC <= 0 || chunkCC <= 0) return fileVal;

    const maturity = Math.min(1, chunkCC / 3);
    const alpha = Math.min(1, (chunkCC / fileCC) * maturity);

    return alpha * chunkVal + (1 - alpha) * fileVal;
  }

  /**
   * Read a raw source value from the payload for adaptive bounds computation.
   */
  private readRawSource(result: RerankableResult, source: string): number | undefined {
    const git = result.payload?.git;
    if (!git) return undefined;

    if (source.startsWith("chunk.")) {
      const field = source.slice(6);
      const chunk = git.chunk as Record<string, unknown> | undefined;
      const val = chunk?.[field];
      return typeof val === "number" ? val : undefined;
    }

    // File-level: check nested first, then flat
    const file = git.file as Record<string, unknown> | undefined;
    if (file) {
      const val = file[source];
      if (typeof val === "number") return val;
    }
    const val = git[source];
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
    _derivedValues: Record<string, number>,
    mask?: OverlayMask,
  ): RankingOverlay {
    const rawFile: Record<string, unknown> = {};
    const rawChunk: Record<string, unknown> = {};

    if (mask) {
      if (mask.file) {
        for (const field of mask.file) {
          this.extractRawSource(result, field, rawFile, rawChunk);
        }
      }
      if (mask.chunk) {
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

    return {
      preset: presetName,
      ...(Object.keys(rawFile).length > 0 ? { file: rawFile } : {}),
      ...(Object.keys(rawChunk).length > 0 ? { chunk: rawChunk } : {}),
    };
  }

  /**
   * Extract a raw source value from payload into the correct level (file/chunk).
   */
  private extractRawSource(
    result: RerankableResult,
    source: string,
    rawFile: Record<string, unknown>,
    rawChunk: Record<string, unknown>,
  ): void {
    const git = result.payload?.git;
    if (!git) return;

    if (source.startsWith("chunk.")) {
      const field = source.slice(6);
      const chunk = git.chunk as Record<string, unknown> | undefined;
      if (chunk && field in chunk) {
        rawChunk[field] = chunk[field];
      }
    } else {
      // File-level: check nested first, then flat
      const file = git.file as Record<string, unknown> | undefined;
      if (file && source in file) {
        rawFile[source] = file[source];
      } else if (source in git) {
        rawFile[source] = git[source];
      }
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
