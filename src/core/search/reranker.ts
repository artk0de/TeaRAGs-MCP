/**
 * Reranker module for search result scoring
 *
 * Provides reranking capabilities for search results based on
 * git metadata and other signals. Supports both preset modes
 * and custom weight configurations.
 */

import type { DerivedSignalDescriptor, RankingOverlay, RerankedResult } from "../contracts/types/reranker.js";

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
  recencyWeightedFreq?: number;
  changeDensity?: number;
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

/**
 * Per-signal confidence thresholds.
 * Signals derived from binary proportions (bugFixRate, churnVolatility)
 * need more samples to be statistically meaningful than simple counts.
 */
const CONFIDENCE_THRESHOLDS: Partial<Record<keyof ScoringWeights, number>> = {
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
 * Returns 1 when effectiveCommitCount >= threshold, otherwise (n/k)^2.
 * Exported for use by L3 blending (Task 5).
 */
export function signalConfidence(effectiveCommitCount: number, signal: keyof ScoringWeights): number {
  const k = CONFIDENCE_THRESHOLDS[signal] ?? DEFAULT_CONFIDENCE_THRESHOLD;
  if (effectiveCommitCount >= k) return 1;
  return Math.pow(effectiveCommitCount / k, CONFIDENCE_POWER);
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
  maxRelativeChurn: 5.0, // 5x file size in total changes
  maxBurstActivity: 10.0, // 10 recent-weighted commits
  maxChunkChurnRatio: 1.0, // ratio is already 0-1
};

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
 * Compute normalization bounds from the current result batch.
 * Each bound is max(p95(values), floor) so we never shrink below DEFAULT_BOUNDS,
 * but expand when the data distribution exceeds static limits (e.g., monorepos).
 */
function computeAdaptiveBounds(results: RerankableResult[], floor: NormalizationBounds): NormalizationBounds {
  const v: Record<string, number[]> = {};
  const push = (key: string, val: number | undefined) => {
    if (val !== undefined && val > 0) (v[key] ??= []).push(val);
  };

  for (const r of results) {
    const file = resolveFileMeta(r.payload?.git);
    const chunk = resolveChunkMeta(r.payload?.git);
    push("ageDays", file?.ageDays);
    push("commitCount", file?.commitCount);
    push("chunkSize", getChunkSize(r) || undefined);
    push("imports", r.payload?.imports?.length);
    push("bugFixRate", file?.bugFixRate);
    push("volatility", file?.churnVolatility);
    push("changeDensity", file?.changeDensity);
    push("chunkCommitCount", chunk?.commitCount);
    push("relativeChurn", file?.relativeChurn);
    push("burstActivity", file?.recencyWeightedFreq);
    push("chunkChurnRatio", chunk?.churnRatio);
  }

  return {
    maxAgeDays: Math.max(p95(v.ageDays ?? []), floor.maxAgeDays),
    maxCommitCount: Math.max(p95(v.commitCount ?? []), floor.maxCommitCount),
    maxChunkSize: Math.max(p95(v.chunkSize ?? []), floor.maxChunkSize),
    maxImports: Math.max(p95(v.imports ?? []), floor.maxImports),
    maxBugFixRate: Math.max(p95(v.bugFixRate ?? []), floor.maxBugFixRate),
    maxVolatility: Math.max(p95(v.volatility ?? []), floor.maxVolatility),
    maxChangeDensity: Math.max(p95(v.changeDensity ?? []), floor.maxChangeDensity),
    maxChunkCommitCount: Math.max(p95(v.chunkCommitCount ?? []), floor.maxChunkCommitCount),
    maxRelativeChurn: Math.max(p95(v.relativeChurn ?? []), floor.maxRelativeChurn),
    maxBurstActivity: Math.max(p95(v.burstActivity ?? []), floor.maxBurstActivity),
    maxChunkChurnRatio: Math.max(p95(v.chunkChurnRatio ?? []), floor.maxChunkChurnRatio),
  };
}

/**
 * Preset weight configurations for semantic_search
 */
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

/** Minimum chunk commits for full maturity in alpha computation */
const CHUNK_MATURITY_THRESHOLD = 3;

/** Compute alpha: confidence weight for chunk vs file data */
function computeAlpha(chunkCommitCount: number | undefined, fileCommitCount: number): number {
  if (chunkCommitCount === undefined || chunkCommitCount === 0) return 0;
  if (fileCommitCount === 0) return 0;
  const coverageRatio = chunkCommitCount / fileCommitCount;
  const maturity = Math.min(1, chunkCommitCount / CHUNK_MATURITY_THRESHOLD);
  return Math.min(1, coverageRatio * maturity);
}

/** Blend chunk and file signal values using alpha */
function effectiveSignal(chunkValue: number | undefined, fileValue: number, alpha: number): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}

/** Continuous data-quality discount replacing binary blockPenalty */
function getDataQualityDiscount(result: RerankableResult, alpha: number): number {
  if (result.payload?.chunkType !== "block") return 0;
  return 1.0 - alpha;
}

/**
 * Calculate scoring signals from result
 */
function calculateSignals(result: RerankableResult, bounds: NormalizationBounds): Record<string, number> {
  const git = result.payload?.git;
  const file = resolveFileMeta(git);
  const chunk = resolveChunkMeta(git);

  const fileCommitCount = file?.commitCount ?? 0;
  const fileAgeDays = file?.ageDays ?? 0;
  const chunkSize = getChunkSize(result);
  const imports = result.payload?.imports?.length ?? 0;

  // L3 alpha-blending: confidence weight for chunk vs file data
  const alpha = computeAlpha(chunk?.commitCount, fileCommitCount);

  const effectiveCommitCount = effectiveSignal(chunk?.commitCount, fileCommitCount, alpha);
  const effectiveAgeDays = effectiveSignal(chunk?.ageDays, fileAgeDays, alpha);
  const effectiveBugFixRate = effectiveSignal(chunk?.bugFixRate, file?.bugFixRate ?? 0, alpha);
  const effectiveContributorCount = effectiveSignal(chunk?.contributorCount, file?.contributorCount ?? 0, alpha);
  const effectiveRelativeChurn = effectiveSignal(chunk?.relativeChurn, file?.relativeChurn ?? 0, alpha);

  // Per-signal quadratic confidence dampening for statistical signals.
  // Factual signals (recency, age, churn counts) are not affected.

  return {
    similarity: result.score,
    recency: 1 - normalize(effectiveAgeDays, bounds.maxAgeDays),
    stability: 1 - normalize(effectiveCommitCount, bounds.maxCommitCount),
    churn: normalize(effectiveCommitCount, bounds.maxCommitCount),
    age: normalize(effectiveAgeDays, bounds.maxAgeDays),
    ownership: getOwnershipScore(result) * signalConfidence(effectiveCommitCount, "ownership"),
    chunkSize: normalize(chunkSize, bounds.maxChunkSize),
    documentation: result.payload?.isDocumentation ? 1 : 0,
    imports: normalize(imports, bounds.maxImports),
    pathRisk: getPathRiskScore(result),
    bugFix: normalize(effectiveBugFixRate, bounds.maxBugFixRate) * signalConfidence(effectiveCommitCount, "bugFix"),
    volatility:
      normalize(file?.churnVolatility ?? 0, bounds.maxVolatility) *
      signalConfidence(effectiveCommitCount, "volatility"),
    density:
      normalize(effectiveSignal(chunk?.changeDensity, file?.changeDensity ?? 0, alpha), bounds.maxChangeDensity) *
      signalConfidence(effectiveCommitCount, "density"),
    // Chunk-native signals dampened by alpha instead of raw
    chunkChurn: normalize(chunk?.commitCount ?? 0, bounds.maxChunkCommitCount) * alpha,
    relativeChurnNorm:
      normalize(effectiveRelativeChurn, bounds.maxRelativeChurn) *
      signalConfidence(effectiveCommitCount, "relativeChurnNorm"),
    burstActivity: normalize(
      effectiveSignal(chunk?.recencyWeightedFreq, file?.recencyWeightedFreq ?? 0, alpha),
      bounds.maxBurstActivity,
    ),
    knowledgeSilo:
      getKnowledgeSiloScore(result, effectiveContributorCount) *
      signalConfidence(effectiveCommitCount, "knowledgeSilo"),
    // Chunk-native signal dampened by alpha
    chunkRelativeChurn: normalize(chunk?.churnRatio ?? 0, bounds.maxChunkChurnRatio) * alpha,
    blockPenalty: getDataQualityDiscount(result, alpha),
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

// ---------------------------------------------------------------------------
// Reranker v2 — descriptor-aware class with ranking overlay
// ---------------------------------------------------------------------------

/**
 * Reranker v2 — descriptor-aware reranker with ranking overlay.
 *
 * Wraps existing scoring logic (calculateSignals, calculateScore) and
 * adds ranking overlay to explain WHY each result scored the way it did.
 * Uses descriptors from providers for overlay metadata only — scoring
 * behavior is preserved exactly from the monolith.
 */
export class Reranker {
  private readonly descriptorMap: Map<string, DerivedSignalDescriptor>;

  constructor(
    private readonly providerDescriptors: DerivedSignalDescriptor[],
    private readonly structuralDescriptors: DerivedSignalDescriptor[],
  ) {
    this.descriptorMap = new Map();
    for (const d of [...providerDescriptors, ...structuralDescriptors]) {
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
  ): RerankedResult[] {
    const presets = presetSet === "semantic_search" ? SEMANTIC_SEARCH_PRESETS : SEARCH_CODE_PRESETS;

    // Resolve weights
    let weights: ScoringWeights;
    let presetName: string;
    if (typeof mode === "string") {
      presetName = mode;
      weights = (presets as Record<string, ScoringWeights>)[mode] || presets.relevance || { similarity: 1.0 };
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
      return results.map((r) => ({ ...r }) as RerankedResult);
    }

    // Compute adaptive bounds
    const bounds = computeAdaptiveBounds(results, DEFAULT_BOUNDS);

    // Score each result and attach overlay
    const scored = results.map((result) => {
      const signals = calculateSignals(result, bounds);
      const score = calculateScore(signals, weights);
      const overlay = this.buildOverlay(result, presetName, weights, signals);
      return { ...result, score, rankingOverlay: overlay } as RerankedResult;
    });

    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Get preset weights for a specific preset name and tool.
   */
  getPreset(name: string, tool: "semantic_search" | "search_code"): ScoringWeights | undefined {
    const presets = tool === "semantic_search" ? SEMANTIC_SEARCH_PRESETS : SEARCH_CODE_PRESETS;
    return (presets as Record<string, ScoringWeights>)[name];
  }

  /**
   * Get available preset names for a tool.
   */
  getAvailablePresets(tool: "semantic_search" | "search_code"): string[] {
    return tool === "semantic_search" ? Object.keys(SEMANTIC_SEARCH_PRESETS) : Object.keys(SEARCH_CODE_PRESETS);
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
    const git = result.payload?.git as Record<string, unknown> | undefined;
    if (!git) return;

    if (source.startsWith("chunk.")) {
      const field = source.slice(6); // Remove "chunk." prefix
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
// Facade functions (backward-compatible functional API)
// ---------------------------------------------------------------------------

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
  bounds?: NormalizationBounds,
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

  // Use caller-provided bounds, or compute adaptive bounds from the result batch.
  // Adaptive bounds expand beyond DEFAULT_BOUNDS when the data distribution requires it
  // (e.g., monorepo with commitCount=300 vs DEFAULT max of 50), but never shrink below.
  const effectiveBounds = bounds ?? computeAdaptiveBounds(results, DEFAULT_BOUNDS);

  // Calculate new scores and sort
  const scored = results.map((result) => {
    const signals = calculateSignals(result, effectiveBounds);
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
