/**
 * Reranker module for search result scoring
 *
 * Provides reranking capabilities for search results based on
 * git metadata and other signals. Supports both preset modes
 * and custom weight configurations.
 */

/**
 * Custom scoring weights configuration
 */
export interface ScoringWeights {
  similarity?: number; // default 1.0
  recency?: number; // inverse ageDays (0-1)
  stability?: number; // inverse commitCount (0-1)
  churn?: number; // direct commitCount (0-1)
  age?: number; // direct ageDays (0-1)
  ownership?: number; // author concentration (0-1)
  chunkSize?: number; // lines of code (0-1)
  documentation?: number; // isDocumentation boost
  imports?: number; // import/dependency count
  bugFix?: number; // bugFixRate — higher = more fixes (0-1)
  volatility?: number; // churnVolatility — erratic changes (0-1)
  density?: number; // changeDensity — commits/month (0-1)
  chunkChurn?: number; // chunk-level commit count (0-1)
}

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

/**
 * Rerank mode type - preset string or custom weights
 */
export type RerankMode<T extends string> = T | { custom: ScoringWeights };

/**
 * Git metadata from search result payload
 */
export interface GitMetadata {
  ageDays?: number;
  commitCount?: number;
  dominantAuthor?: string;
  dominantAuthorEmail?: string;
  authors?: string[];
  dominantAuthorPct?: number;
  relativeChurn?: number;
  recencyWeightedFreq?: number;
  changeDensity?: number;
  churnVolatility?: number;
  bugFixRate?: number;
  contributorCount?: number;
  taskIds?: string[];
  // Chunk-level (Phase B):
  chunkCommitCount?: number;
  chunkChurnRatio?: number;
  chunkContributorCount?: number;
  chunkBugFixRate?: number;
  chunkAgeDays?: number;
}

/**
 * Search result with payload for reranking
 */
export interface RerankableResult {
  score: number;
  payload?: {
    relativePath?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    isDocumentation?: boolean;
    imports?: string[];
    exports?: string[];
    git?: GitMetadata;
    [key: string]: unknown;
  };
}

/**
 * Normalization bounds for scoring signals
 */
interface NormalizationBounds {
  maxAgeDays: number;
  maxCommitCount: number;
  maxChunkSize: number;
  maxImports: number;
  maxBugFixRate: number;
  maxVolatility: number;
  maxChangeDensity: number;
  maxChunkCommitCount: number;
}

const DEFAULT_BOUNDS: NormalizationBounds = {
  maxAgeDays: 365, // 1 year
  maxCommitCount: 50,
  maxChunkSize: 500, // lines
  maxImports: 20,
  maxBugFixRate: 100, // percentage
  maxVolatility: 60, // stddev days
  maxChangeDensity: 20, // commits/month
  maxChunkCommitCount: 30,
};

/**
 * Preset weight configurations for semantic_search
 */
const SEMANTIC_SEARCH_PRESETS: Record<SemanticSearchRerankPreset, ScoringWeights> = {
  relevance: { similarity: 1.0 },

  techDebt: {
    similarity: 0.25,
    age: 0.2,
    churn: 0.2,
    bugFix: 0.15,
    volatility: 0.2,
  },

  hotspots: {
    similarity: 0.35,
    chunkChurn: 0.25,
    recency: 0.1,
    bugFix: 0.15,
    volatility: 0.15,
  },

  codeReview: {
    similarity: 0.4,
    recency: 0.2,
    density: 0.2,
    chunkChurn: 0.2,
  },

  onboarding: {
    similarity: 0.4,
    documentation: 0.3,
    stability: 0.3,
  },

  securityAudit: {
    similarity: 0.35,
    age: 0.2,
    ownership: 0.15,
    bugFix: 0.15,
    // pathRisk would be handled separately
  },

  refactoring: {
    similarity: 0.25,
    chunkChurn: 0.25,
    chunkSize: 0.15,
    volatility: 0.15,
    bugFix: 0.1,
    age: 0.1,
  },

  ownership: {
    similarity: 0.5,
    ownership: 0.5,
  },

  impactAnalysis: {
    similarity: 0.5,
    imports: 0.5,
  },
};

/**
 * Preset weight configurations for search_code
 */
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

/**
 * Normalize a value to 0-1 range
 */
function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/**
 * Calculate chunk size from line numbers
 */
function getChunkSize(result: RerankableResult): number {
  const start = result.payload?.startLine || 0;
  const end = result.payload?.endLine || 0;
  return Math.max(0, end - start);
}

/**
 * Calculate author concentration (ownership signal)
 * Higher value = more concentrated ownership
 */
function getOwnershipScore(result: RerankableResult): number {
  const git = result.payload?.git;
  // Use dominantAuthorPct (0-100) when available for precise ownership
  if (git?.dominantAuthorPct !== undefined && git.dominantAuthorPct > 0) {
    return git.dominantAuthorPct / 100;
  }
  const authors = git?.authors;
  if (!authors || authors.length === 0) return 0;
  if (authors.length === 1) return 1;
  // More authors = less concentrated ownership
  return 1 / authors.length;
}

/**
 * Check if path matches security-sensitive patterns
 */
function getPathRiskScore(result: RerankableResult): number {
  const path = result.payload?.relativePath?.toLowerCase() || "";
  const riskyPatterns = [
    "auth",
    "security",
    "crypto",
    "password",
    "secret",
    "token",
    "credential",
    "permission",
    "access",
  ];
  return riskyPatterns.some((p) => path.includes(p)) ? 1 : 0;
}

/**
 * Calculate scoring signals from result
 */
function calculateSignals(
  result: RerankableResult,
  bounds: NormalizationBounds,
): Record<string, number> {
  const git = result.payload?.git;
  const ageDays = git?.ageDays ?? 0;
  const commitCount = git?.commitCount ?? 0;
  const chunkSize = getChunkSize(result);
  const imports = result.payload?.imports?.length ?? 0;

  // Prefer chunk-level data when available
  const effectiveCommitCount = git?.chunkCommitCount ?? commitCount;
  const effectiveAgeDays = git?.chunkAgeDays ?? ageDays;

  return {
    similarity: result.score,
    recency: 1 - normalize(effectiveAgeDays, bounds.maxAgeDays),
    stability: 1 - normalize(effectiveCommitCount, bounds.maxCommitCount),
    churn: normalize(effectiveCommitCount, bounds.maxCommitCount),
    age: normalize(effectiveAgeDays, bounds.maxAgeDays),
    ownership: getOwnershipScore(result),
    chunkSize: normalize(chunkSize, bounds.maxChunkSize),
    documentation: result.payload?.isDocumentation ? 1 : 0,
    imports: normalize(imports, bounds.maxImports),
    pathRisk: getPathRiskScore(result),
    // New signals:
    bugFix: normalize(git?.bugFixRate ?? 0, bounds.maxBugFixRate),
    volatility: normalize(git?.churnVolatility ?? 0, bounds.maxVolatility),
    density: normalize(git?.changeDensity ?? 0, bounds.maxChangeDensity),
    chunkChurn: normalize(git?.chunkCommitCount ?? 0, bounds.maxChunkCommitCount),
  };
}

/**
 * Calculate final score based on weights and signals
 */
function calculateScore(
  signals: Record<string, number>,
  weights: ScoringWeights,
): number {
  let score = 0;
  let totalWeight = 0;

  for (const [key, weight] of Object.entries(weights)) {
    if (weight && weight > 0 && key in signals) {
      score += signals[key] * weight;
      totalWeight += weight;
    }
  }

  // Normalize by total weight to keep score in 0-1 range
  return totalWeight > 0 ? score / totalWeight : signals.similarity || 0;
}

/**
 * Rerank search results using specified mode
 *
 * @param results - Search results to rerank
 * @param mode - Preset name or custom weights
 * @param presets - Preset configurations to use
 * @param bounds - Optional normalization bounds override
 * @returns Reranked results sorted by new score
 */
export function rerankResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<string>,
  presets: Record<string, ScoringWeights>,
  bounds: NormalizationBounds = DEFAULT_BOUNDS,
): T[] {
  // Determine weights
  let weights: ScoringWeights;
  if (typeof mode === "string") {
    weights = presets[mode] || presets.relevance || { similarity: 1.0 };
  } else {
    weights = mode.custom;
  }

  // If only similarity weight, skip reranking
  const weightKeys = Object.keys(weights).filter(
    (k) => weights[k as keyof ScoringWeights] && weights[k as keyof ScoringWeights]! > 0,
  );
  if (weightKeys.length === 1 && weightKeys[0] === "similarity") {
    return results;
  }

  // Calculate new scores and sort
  const scored = results.map((result) => {
    const signals = calculateSignals(result, bounds);
    const newScore = calculateScore(signals, weights);
    return { ...result, score: newScore };
  });

  // Sort by new score descending
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Rerank semantic_search results
 */
export function rerankSemanticSearchResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<SemanticSearchRerankPreset> = "relevance",
  bounds?: NormalizationBounds,
): T[] {
  return rerankResults(results, mode, SEMANTIC_SEARCH_PRESETS, bounds);
}

/**
 * Rerank search_code results
 */
export function rerankSearchCodeResults<T extends RerankableResult>(
  results: T[],
  mode: RerankMode<SearchCodeRerankPreset> = "relevance",
  bounds?: NormalizationBounds,
): T[] {
  return rerankResults(results, mode, SEARCH_CODE_PRESETS, bounds);
}

/**
 * Get available presets for a tool
 */
export function getAvailablePresets(
  tool: "semantic_search" | "search_code",
): string[] {
  if (tool === "semantic_search") {
    return Object.keys(SEMANTIC_SEARCH_PRESETS);
  }
  return Object.keys(SEARCH_CODE_PRESETS);
}
