/**
 * Reranker module for search result scoring
 *
 * Descriptor-based scoring: each DerivedSignalDescriptor knows how to
 * extract its normalized value from the payload. The Reranker:
 * 1. Computes adaptive bounds (p95 from batch, floored with descriptor.defaultBound)
 * 2. Calls descriptor.extract(payload, adaptiveBound) for each signal
 * 3. Applies confidence dampening (needsConfidence + confidenceField)
 * 4. Computes weighted sum score
 * 5. Attaches ranking overlay (raw + derived signals for transparency)
 */

import type { ScoringWeights } from "../contracts/types/provider.js";
import type {
  DerivedSignalDescriptor,
  RankingOverlay,
  RerankableResult,
  RerankMode,
  RerankPreset,
} from "../contracts/types/reranker.js";
import { gitDerivedSignals } from "../trajectory/git/signals.js";
// ---------------------------------------------------------------------------
// Facade functions (backward-compatible functional API)
// ---------------------------------------------------------------------------

// Lazy singleton for facade functions (avoids circular import issues).
// The facade creates its own Reranker without provider descriptors — consumers
// needing full provider descriptors should use the Reranker class directly.
import { structuralSignals } from "./structural-signals.js";

// Re-export types from contracts for backward compatibility
export type { ScoringWeights } from "../contracts/types/provider.js";
export type { RerankableResult, RerankMode } from "../contracts/types/reranker.js";

/**
 * Rerank presets for semantic_search (analytics use cases)
 */
export type SemanticSearchRerankPreset =
  | "relevance" // default: similarity only
  | "techDebt" // old code + high churn
  | "hotspots" // bug hunting: high churn + recent
  | "codeReview" // recent changes
  | "onboarding" // entry points, documentation, stable code
  | "securityAudit" // old code in critical paths
  | "refactoring" // refactoring candidates
  | "ownership" // knowledge transfer: who is expert
  | "impactAnalysis"; // what will be affected by change

/**
 * Rerank presets for search_code (practical development)
 */
export type SearchCodeRerankPreset =
  | "relevance" // default: similarity only
  | "recent" // boost recently modified code
  | "stable"; // boost stable/low-churn code

// ---------------------------------------------------------------------------
// Preset weight configurations
// ---------------------------------------------------------------------------

const SEMANTIC_SEARCH_PRESETS: Record<SemanticSearchRerankPreset, ScoringWeights> = {
  relevance: { similarity: 1.0 },

  techDebt: {
    similarity: 0.2,
    age: 0.15,
    churn: 0.15,
    bugFix: 0.15,
    volatility: 0.1,
    knowledgeSilo: 0.1,
    density: 0.1,
    blockPenalty: -0.05,
  },

  hotspots: {
    similarity: 0.25,
    chunkChurn: 0.15,
    chunkRelativeChurn: 0.15,
    burstActivity: 0.15,
    bugFix: 0.15,
    volatility: 0.15,
    blockPenalty: -0.15,
  },

  codeReview: {
    similarity: 0.35,
    recency: 0.15,
    burstActivity: 0.15,
    density: 0.15,
    chunkChurn: 0.2,
    blockPenalty: -0.1,
  },

  onboarding: {
    similarity: 0.4,
    documentation: 0.3,
    stability: 0.3,
  },

  securityAudit: {
    similarity: 0.3,
    age: 0.15,
    ownership: 0.1,
    bugFix: 0.15,
    pathRisk: 0.15,
    volatility: 0.15,
  },

  refactoring: {
    similarity: 0.2,
    chunkChurn: 0.15,
    relativeChurnNorm: 0.15,
    chunkSize: 0.15,
    volatility: 0.15,
    bugFix: 0.1,
    age: 0.1,
    blockPenalty: -0.1,
  },

  ownership: {
    similarity: 0.4,
    ownership: 0.35,
    knowledgeSilo: 0.25,
  },

  impactAnalysis: {
    similarity: 0.5,
    imports: 0.5,
  },
};

const SEARCH_CODE_PRESETS: Record<SearchCodeRerankPreset, ScoringWeights> = {
  relevance: { similarity: 1.0 },

  recent: {
    similarity: 0.7,
    recency: 0.3,
  },

  stable: {
    similarity: 0.7,
    stability: 0.3,
  },
};

// ---------------------------------------------------------------------------
// Scoring utilities
// ---------------------------------------------------------------------------

/**
 * Calculate the 95th percentile of a numeric array.
 * Returns 1 for empty arrays to avoid division by zero downstream.
 */
function p95(arr: number[]): number {
  if (arr.length === 0) return 1;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)] || 1;
}

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
  private readonly allDescriptors: DerivedSignalDescriptor[];

  constructor(
    private readonly providerDescriptors: DerivedSignalDescriptor[],
    private readonly structuralDescriptors: DerivedSignalDescriptor[],
    private readonly resolvedPresets?: RerankPreset[],
  ) {
    this.allDescriptors = [...providerDescriptors, ...structuralDescriptors];
    this.descriptorMap = new Map();
    for (const d of this.allDescriptors) {
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
    // Resolve weights
    let weights: ScoringWeights;
    let presetName: string;
    if (typeof mode === "string") {
      presetName = mode;
      weights = this.getWeights(mode, presetSet) ?? { similarity: 1.0 };
    } else {
      presetName = "custom";
      weights = mode.custom;
    }

    // Fast path: similarity-only → no reranking, no overlay
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
      const overlay = this.buildOverlay(result, presetName, weights, signals);
      return { ...result, score, rankingOverlay: overlay };
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Get preset weights for a specific preset name and tool.
   */
  getPreset(name: string, tool: "semantic_search" | "search_code"): ScoringWeights | undefined {
    if (this.resolvedPresets) {
      return this.resolvedPresets.find((p) => p.name === name && p.tool === tool)?.weights;
    }
    // Fallback to hardcoded (removed in Task 7)
    const presets = tool === "semantic_search" ? SEMANTIC_SEARCH_PRESETS : SEARCH_CODE_PRESETS;
    return (presets as Record<string, ScoringWeights>)[name];
  }

  /**
   * Get available preset names for a tool.
   */
  getAvailablePresets(tool: "semantic_search" | "search_code"): string[] {
    if (this.resolvedPresets) {
      return this.resolvedPresets.filter((p) => p.tool === tool).map((p) => p.name);
    }
    return tool === "semantic_search" ? Object.keys(SEMANTIC_SEARCH_PRESETS) : Object.keys(SEARCH_CODE_PRESETS);
  }

  /** Descriptor info for MCP schema generation. */
  getDescriptorInfo(): { name: string; description: string }[] {
    return [...this.providerDescriptors, ...this.structuralDescriptors].map((d) => ({
      name: d.name,
      description: d.description,
    }));
  }

  /** Preset names for a specific tool — uses resolvedPresets if available. */
  getPresetNames(tool: string): string[] {
    if (this.resolvedPresets) {
      return this.resolvedPresets.filter((p) => p.tool === tool).map((p) => p.name);
    }
    // Fallback (removed in Task 7)
    if (tool === "semantic_search") return Object.keys(SEMANTIC_SEARCH_PRESETS);
    return Object.keys(SEARCH_CODE_PRESETS);
  }

  // ── Private methods ──

  /**
   * Resolve weights for a named preset — resolvedPresets first, hardcoded fallback.
   */
  private getWeights(mode: string, tool: string): ScoringWeights | undefined {
    if (this.resolvedPresets) {
      const preset = this.resolvedPresets.find((p) => p.name === mode && p.tool === tool);
      if (preset) return preset.weights;
    }
    // Fallback to hardcoded (will be removed in Task 7)
    if (tool === "semantic_search") return SEMANTIC_SEARCH_PRESETS[mode as SemanticSearchRerankPreset];
    return SEARCH_CODE_PRESETS[mode as SearchCodeRerankPreset];
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
      for (const d of this.allDescriptors) {
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
      const d = this.descriptorMap.get(name)!;
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

    for (const d of this.allDescriptors) {
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
   * Includes derived signal values used by the preset and their raw sources.
   */
  private buildOverlay(
    result: RerankableResult,
    presetName: string,
    weights: ScoringWeights,
    derivedValues: Record<string, number>,
  ): RankingOverlay {
    const derived: Record<string, number> = {};
    const rawFile: Record<string, unknown> = {};
    const rawChunk: Record<string, unknown> = {};

    for (const key of Object.keys(weights)) {
      const w = weights[key as keyof ScoringWeights];
      if (w === undefined || w === 0) continue;

      // Add derived value
      if (key in derivedValues) {
        derived[key] = derivedValues[key];
      }

      // Find descriptor and extract raw source values
      const descriptor = this.descriptorMap.get(key);
      if (descriptor) {
        for (const source of descriptor.sources) {
          this.extractRawSource(result, source, rawFile, rawChunk);
        }
      }
    }

    return {
      preset: presetName,
      derived,
      raw: {
        ...(Object.keys(rawFile).length > 0 ? { file: rawFile } : {}),
        ...(Object.keys(rawChunk).length > 0 ? { chunk: rawChunk } : {}),
      },
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

let _facadeReranker: Reranker | undefined;
function getFacadeReranker(): Reranker {
  if (!_facadeReranker) {
    _facadeReranker = new Reranker(gitDerivedSignals, structuralSignals);
  }
  return _facadeReranker;
}

/**
 * Rerank search results using specified mode (backward-compatible facade)
 */
export function rerankResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<string>,
  presets: Record<string, ScoringWeights>,
): T[] {
  // Resolve weights from the provided presets
  let weights: ScoringWeights;
  if (typeof mode === "string") {
    weights = presets[mode] || presets.relevance || { similarity: 1.0 };
  } else {
    weights = mode.custom;
  }

  // If only similarity weight, skip reranking
  const weightKeys = Object.keys(weights).filter((k) => {
    const w = weights[k as keyof ScoringWeights];
    return w !== undefined && w !== 0;
  });
  if (weightKeys.length === 1 && weightKeys[0] === "similarity") {
    return results;
  }

  // Delegate to Reranker for scoring
  const reranker = getFacadeReranker();
  const ranked = reranker.rerank(results, mode, "semantic_search");
  // Strip rankingOverlay to match old return type
  return ranked.map(({ rankingOverlay: _, ...rest }) => rest as unknown as T);
}

/**
 * Rerank semantic_search results
 */
export function rerankSemanticSearchResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<SemanticSearchRerankPreset> = "relevance",
): T[] {
  // For similarity-only, short-circuit
  if (mode === "relevance") return results;

  const reranker = getFacadeReranker();
  const ranked = reranker.rerank(results, mode, "semantic_search");
  return ranked.map(({ rankingOverlay: _, ...rest }) => rest as unknown as T);
}

/**
 * Rerank search_code results
 */
export function rerankSearchCodeResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<SearchCodeRerankPreset> = "relevance",
): T[] {
  if (mode === "relevance") return results;

  const reranker = getFacadeReranker();
  const ranked = reranker.rerank(results, mode, "search_code");
  return ranked.map(({ rankingOverlay: _, ...rest }) => rest as unknown as T);
}

/**
 * Get available presets for a tool
 */
export function getAvailablePresets(tool: "semantic_search" | "search_code"): string[] {
  if (tool === "semantic_search") {
    return Object.keys(SEMANTIC_SEARCH_PRESETS);
  }
  return Object.keys(SEARCH_CODE_PRESETS);
}
