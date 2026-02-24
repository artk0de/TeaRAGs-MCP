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
  relativeChurnNorm?: number; // relativeChurn normalized (churn relative to file size)
  burstActivity?: number; // recencyWeightedFreq — recent burst of changes (0-1)
  pathRisk?: number; // security-sensitive path pattern match (0 or 1)
  knowledgeSilo?: number; // single-contributor flag (1.0 / 0.5 / 0)
  chunkRelativeChurn?: number; // chunkChurnRatio — chunk's share of file churn (0-1)
  blockPenalty?: number; // negative weight: penalize block chunks with only file-level churn data
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
 * File-level git fields (shared between flat and nested formats)
 */
export interface GitFileFields {
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
}

/**
 * Chunk-level git overlay fields
 */
export interface GitChunkFields {
  commitCount?: number;
  churnRatio?: number;
  contributorCount?: number;
  bugFixRate?: number;
  lastModifiedAt?: number;
  ageDays?: number;
  relativeChurn?: number;
}

/**
 * Git metadata from search result payload.
 *
 * Supports both nested format (new: { file: {...}, chunk: {...} })
 * and flat format (old: all fields at root level) for backward compatibility.
 */
export interface GitMetadata extends GitFileFields {
  // Nested structure (new payload format from EnrichmentApplier)
  file?: GitFileFields;
  chunk?: GitChunkFields;
  // Old flat chunk-level fields (backward compat for pre-nesting indexes)
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
    chunkType?: string;
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
  maxRelativeChurn: number;
  maxBurstActivity: number;
  maxChunkChurnRatio: number;
}

/** Minimum commits for full confidence in statistical git signals */
const MIN_CONFIDENT_COMMITS = 5;

const DEFAULT_BOUNDS: NormalizationBounds = {
  maxAgeDays: 365, // 1 year
  maxCommitCount: 50,
  maxChunkSize: 500, // lines
  maxImports: 20,
  maxBugFixRate: 100, // percentage
  maxVolatility: 60, // stddev days
  maxChangeDensity: 20, // commits/month
  maxChunkCommitCount: 30,
  maxRelativeChurn: 5.0, // 5x file size in total changes
  maxBurstActivity: 10.0, // 10 recent-weighted commits
  maxChunkChurnRatio: 1.0, // ratio is already 0-1
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
    blockPenalty: -0.15,
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
 * Resolve file-level git metadata.
 * Supports both nested { file: {...} } and flat { ageDays, commitCount, ... } formats.
 */
function resolveFileMeta(git: GitMetadata | undefined): GitFileFields | undefined {
  if (!git) return undefined;
  return git.file ?? git;
}

/**
 * Resolve chunk-level git metadata.
 * Supports both nested { chunk: {...} } and old flat { chunkCommitCount, ... } format.
 */
function resolveChunkMeta(git: GitMetadata | undefined): GitChunkFields | undefined {
  if (!git) return undefined;
  if (git.chunk) return git.chunk;
  // Flat fallback for old indexes — check if any old chunk field exists
  if (
    git.chunkCommitCount !== undefined ||
    git.chunkChurnRatio !== undefined ||
    git.chunkContributorCount !== undefined ||
    git.chunkBugFixRate !== undefined ||
    git.chunkAgeDays !== undefined
  ) {
    return {
      commitCount: git.chunkCommitCount,
      churnRatio: git.chunkChurnRatio,
      contributorCount: git.chunkContributorCount,
      bugFixRate: git.chunkBugFixRate,
      ageDays: git.chunkAgeDays,
    };
  }
  return undefined;
}

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
  const file = resolveFileMeta(result.payload?.git);
  // Use dominantAuthorPct (0-100) when available for precise ownership
  if (file?.dominantAuthorPct !== undefined && file.dominantAuthorPct > 0) {
    return file.dominantAuthorPct / 100;
  }
  const authors = file?.authors;
  if (!authors || authors.length === 0) return 0;
  if (authors.length === 1) return 1;
  // More authors = less concentrated ownership
  return 1 / authors.length;
}

/**
 * Flag single-contributor code (knowledge silo risk)
 * 1 contributor = 1.0 (high silo risk), 2 = 0.5, 3+ = 0
 */
function getKnowledgeSiloScore(result: RerankableResult, effectiveCount?: number): number {
  const count = effectiveCount ?? result.payload?.git?.contributorCount;
  if (count === undefined || count <= 0) return 0;
  if (count === 1) return 1.0;
  if (count === 2) return 0.5;
  return 0;
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
 * Detect block chunks that only have file-level churn data.
 * Returns 1.0 for block chunks without chunk-level git data (penalty target),
 * 0.0 otherwise (no penalty).
 */
function getBlockPenaltySignal(result: RerankableResult): number {
  const chunkType = result.payload?.chunkType;
  if (chunkType !== "block") return 0;
  // Block with chunk-level data is fine — the data is specific to this chunk
  const chunk = resolveChunkMeta(result.payload?.git);
  if (chunk?.commitCount !== undefined) return 0;
  return 1.0;
}

/**
 * Calculate scoring signals from result
 */
function calculateSignals(result: RerankableResult, bounds: NormalizationBounds): Record<string, number> {
  const git = result.payload?.git;
  const file = resolveFileMeta(git);
  const chunk = resolveChunkMeta(git);

  const ageDays = file?.ageDays ?? 0;
  const commitCount = file?.commitCount ?? 0;
  const chunkSize = getChunkSize(result);
  const imports = result.payload?.imports?.length ?? 0;

  // Prefer chunk-level data when available
  const effectiveCommitCount = chunk?.commitCount ?? commitCount;
  const effectiveAgeDays = chunk?.ageDays ?? ageDays;
  const effectiveBugFixRate = chunk?.bugFixRate ?? file?.bugFixRate ?? 0;
  const effectiveContributorCount = chunk?.contributorCount ?? file?.contributorCount;

  // Dampen statistical signals that are unreliable with small sample sizes.
  // Factual signals (recency, age, churn counts) are not affected.
  const confidence = Math.min(1, effectiveCommitCount / MIN_CONFIDENT_COMMITS);

  return {
    similarity: result.score,
    recency: 1 - normalize(effectiveAgeDays, bounds.maxAgeDays),
    stability: 1 - normalize(effectiveCommitCount, bounds.maxCommitCount),
    churn: normalize(effectiveCommitCount, bounds.maxCommitCount),
    age: normalize(effectiveAgeDays, bounds.maxAgeDays),
    ownership: getOwnershipScore(result) * confidence,
    chunkSize: normalize(chunkSize, bounds.maxChunkSize),
    documentation: result.payload?.isDocumentation ? 1 : 0,
    imports: normalize(imports, bounds.maxImports),
    pathRisk: getPathRiskScore(result),
    bugFix: normalize(effectiveBugFixRate, bounds.maxBugFixRate) * confidence,
    volatility: normalize(file?.churnVolatility ?? 0, bounds.maxVolatility) * confidence,
    density: normalize(file?.changeDensity ?? 0, bounds.maxChangeDensity) * confidence,
    chunkChurn: normalize(chunk?.commitCount ?? 0, bounds.maxChunkCommitCount),
    relativeChurnNorm: normalize(file?.relativeChurn ?? 0, bounds.maxRelativeChurn) * confidence,
    burstActivity: normalize(file?.recencyWeightedFreq ?? 0, bounds.maxBurstActivity),
    knowledgeSilo: getKnowledgeSiloScore(result, effectiveContributorCount) * confidence,
    chunkRelativeChurn: normalize(chunk?.churnRatio ?? 0, bounds.maxChunkChurnRatio),
    blockPenalty: getBlockPenaltySignal(result),
  };
}

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
  const weightKeys = Object.keys(weights).filter((k) => {
    const w = weights[k as keyof ScoringWeights];
    return w !== undefined && w !== 0;
  });
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
export function getAvailablePresets(tool: "semantic_search" | "search_code"): string[] {
  if (tool === "semantic_search") {
    return Object.keys(SEMANTIC_SEARCH_PRESETS);
  }
  return Object.keys(SEARCH_CODE_PRESETS);
}
