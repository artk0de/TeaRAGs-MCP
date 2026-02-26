/**
 * Reranker contract types — shared by search layer and consumers.
 */

import type { ScoringWeights } from "./provider.js";

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
  /** Extract normalized value (0-1) from search result payload */
  extract: (payload: Record<string, unknown>) => number;
  /** Default upper bound for normalization */
  defaultBound?: number;
  /** Whether to apply confidence dampening */
  needsConfidence?: boolean;
  /** Which raw signal field for confidence threshold (default: "commitCount") */
  confidenceField?: string;
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

export interface NormalizationBounds {
  maxAgeDays: number;
  maxCommitCount: number;
  maxChunkSize: number;
  maxImports: number;
  maxBugFixRate: number;
  maxVolatility: number;
  maxChangeDensity: number;
  maxChunkCommitCount: number;
  maxRelativeChurn: number;
  maxBurstActivity: number;
  maxChunkChurnRatio: number;
}

export type SemanticSearchRerankPreset =
  | "relevance"
  | "techDebt"
  | "hotspots"
  | "codeReview"
  | "onboarding"
  | "securityAudit"
  | "refactoring"
  | "ownership"
  | "impactAnalysis";

export type SearchCodeRerankPreset = "relevance" | "recent" | "stable";

export type RerankMode<T extends string> = T | { custom: ScoringWeights };
