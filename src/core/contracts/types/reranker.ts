/**
 * Reranker contract types — shared by search layer and consumers.
 */

import type { ScoringWeights } from "./provider.js";
import type { DampeningConfig, ExtractContext } from "./trajectory.js";

/**
 * Derived signal descriptor — defines how to compute a normalized signal
 * from raw payload data. Used by reranker for scoring and ranking overlay.
 */
export interface DerivedSignalDescriptor {
  /** Derived signal name (weight key in presets) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Raw signal names this derived signal reads from (enables ranking overlay) */
  sources: string[];
  /** Extract normalized value (0-1) from raw signal data.
   *  Optional `ctx.bounds` provides per-source adaptive bounds for normalization. */
  extract: (rawSignals: Record<string, unknown>, ctx?: ExtractContext) => number;
  /** Default upper bound for normalization */
  defaultBound?: number;
  /** Dampening source: which collection stat to use as confidence threshold. */
  dampeningSource?: DampeningConfig;
}

export interface RerankableResult {
  score: number;
  payload?: {
    relativePath?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    isDocumentation?: boolean;
    chunkType?: string;
    imports?: string[];
    exports?: string[];
    git?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/** Curates which raw signals appear in the ranking overlay for a preset. */
export interface OverlayMask {
  readonly file?: string[];
  readonly chunk?: string[];
}

/** Typed preset definition with description for schema generation and DI. */
export interface RerankPreset {
  readonly name: string;
  readonly description: string;
  readonly tools: string[];
  readonly weights: ScoringWeights;
  readonly overlayMask: OverlayMask;
}

export type RerankMode<T extends string> = T | { custom: ScoringWeights };

/** Ranking overlay attached to each reranked result — explains WHY it scored this way. */
export interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

/** Search result with ranking overlay from reranker. */
export interface RerankedResult extends RerankableResult {
  rankingOverlay?: RankingOverlay;
}
