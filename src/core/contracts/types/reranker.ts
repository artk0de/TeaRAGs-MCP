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
  /** Whether this signal inverts the raw value (1 - normalize pattern).
   *  Used by rank_chunks to determine scroll direction: inverted=true → asc. */
  inverted?: boolean;
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
  readonly derived?: string[];
}

/** Granularity level for reranking signals. */
export type SignalLevel = "file" | "chunk";

/** Typed preset definition with description for schema generation and DI. */
export interface RerankPreset {
  readonly name: string;
  readonly description: string;
  readonly tools: string[];
  readonly weights: ScoringWeights;
  readonly overlayMask: OverlayMask;
  /** Payload field to group results by (keep highest-scored per group). Used by rank_chunks. */
  readonly groupBy?: string;
  /** Signal granularity: "file" forces alpha=0 (pure file signals), "chunk" uses blending (default). */
  readonly signalLevel?: SignalLevel;
}

export type RerankMode<T extends string> = T | { custom: ScoringWeights; preset?: T };

/** Ranking overlay attached to each reranked result — explains WHY it scored this way. */
export interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  derived?: Record<string, number>;
}

/** Search result with ranking overlay from reranker. */
export interface RerankedResult extends RerankableResult {
  rankingOverlay?: RankingOverlay;
}
