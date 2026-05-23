/**
 * Reranker contract types — shared by search layer and consumers.
 */

import type { ScoringWeights } from "./provider.js";
import type { ExtractContext } from "./trajectory.js";

/**
 * Derived signal descriptor — defines how to compute a normalized signal
 * from raw payload data. Used by reranker for scoring and ranking overlay.
 *
 * Confidence dampening is declared once on the raw `PayloadSignalDescriptor.stats.confidence`
 * block — reranker pre-resolves `support` + `adaptivePercentile` + `threshold`
 * (floor) and passes them via `ExtractContext.confidence` and
 * `ExtractContext.dampeningThreshold`. Derived signal classes never declare
 * dampening directly; they only consume from ctx.
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
  /** Whether this signal inverts the raw value (1 - normalize pattern).
   *  Used by rank_chunks to determine scroll direction: inverted=true → asc. */
  inverted?: boolean;
}

export interface RerankableResult {
  id?: string | number;
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

/**
 * Composite preset — RerankPreset that blends signals from 2+ trajectories.
 * Declares its trajectory dependencies via the mandatory `requires` field.
 *
 * Provider-specific presets (single-trajectory) implement plain `RerankPreset`
 * and live under their owning trajectory's `rerank/presets/` directory; they
 * are gated implicitly through trajectory registration (the class file is
 * loaded only when the trajectory is registered).
 *
 * Composite presets live under `domains/trajectory/composite/presets/`.
 * `buildCompositePresets(registeredKeys)` filters them by
 * `requires.every(k => registeredKeys.has(k))` — a composite whose
 * dependencies are not all registered is silently dropped, so it never
 * reaches the Reranker, the SchemaBuilder, the MCP preset enum, or the
 * custom-weights schema.
 *
 * Convention: do not list always-on trajectories (e.g. `"static"`) in
 * `requires`. Only declare keys for trajectories that can be disabled.
 */
export interface CompositeRerankPreset extends RerankPreset {
  /** Trajectory keys this preset depends on. ALL must be registered. */
  readonly requires: readonly string[];
}

export type RerankMode<T extends string> = T | { custom: ScoringWeights; preset?: T };

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
