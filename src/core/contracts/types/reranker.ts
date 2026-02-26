/**
 * Reranker contract types — shared by search layer and consumers.
 */

import type { ScoringWeights } from "./provider.js";

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
