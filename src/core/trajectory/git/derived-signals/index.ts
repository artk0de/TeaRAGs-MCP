/**
 * Git signal descriptors for reranking
 *
 * Extracts all 14 git-specific signals from search result payloads
 * into self-contained DerivedSignalDescriptor objects. Each descriptor knows
 * how to read from both nested (git.file.*) and flat (git.*) formats.
 *
 * Descriptors include L3 alpha-blending: when chunk-level data exists,
 * signals blend chunk + file values weighted by alpha (coverage × maturity).
 * Confidence dampening is NOT in descriptors — applied externally by Reranker.
 */

import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimum chunk commits for full maturity in alpha computation */
const CHUNK_MATURITY_THRESHOLD = 3;

/**
 * Compute alpha blending factor for chunk-vs-file data quality.
 * alpha = coverageRatio × maturity, clamped to [0, 1].
 *   coverageRatio = chunkCommitCount / fileCommitCount
 *   maturity = min(1, chunkCommitCount / CHUNK_MATURITY_THRESHOLD)
 *
 * Maturity prevents low-commit chunks (1-2 commits) from overriding
 * reliable file-level statistics.
 */
function computeAlpha(chunkCommitCount: number | undefined, fileCommitCount: number | undefined): number {
  if (chunkCommitCount === undefined || chunkCommitCount <= 0) return 0;
  if (fileCommitCount === undefined || fileCommitCount <= 0) return 0;
  const coverageRatio = chunkCommitCount / fileCommitCount;
  const maturity = Math.min(1, chunkCommitCount / CHUNK_MATURITY_THRESHOLD);
  return Math.min(1, coverageRatio * maturity);
}

/**
 * Blend chunk and file signal values using alpha.
 * When chunkValue is undefined, falls back to fileValue (monolith effectiveSignal semantics).
 */
function blend(chunkValue: number | undefined, fileValue: number, alpha: number): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}

// ---------------------------------------------------------------------------
// Payload accessors (support nested and flat formats)
// ---------------------------------------------------------------------------

interface GitLike {
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Safely extract the git object from the payload.
 */
function getGit(payload: Record<string, unknown>): GitLike | undefined {
  const { git } = payload;
  if (git && typeof git === "object") return git as GitLike;
  return undefined;
}

/**
 * Read a file-level field, checking nested first then flat.
 */
function fileField(payload: Record<string, unknown>, field: string): unknown {
  const git = getGit(payload);
  if (!git) return undefined;
  // Nested: git.file.<field>
  if (git.file && typeof git.file === "object" && field in git.file) {
    return git.file[field];
  }
  // Flat: git.<field>
  if (field in git) {
    return git[field];
  }
  return undefined;
}

/**
 * Read a file-level numeric field.
 */
function fileNum(payload: Record<string, unknown>, field: string): number {
  const val = fileField(payload, field);
  return typeof val === "number" ? val : 0;
}

/**
 * Read a chunk-level field, returning undefined if absent.
 * Distinguishes between "field missing" and "field = 0" for correct blend semantics.
 */
function chunkField(payload: Record<string, unknown>, field: string): number | undefined {
  const git = getGit(payload);
  if (!git?.chunk || typeof git.chunk !== "object") return undefined;
  if (!(field in git.chunk)) return undefined;
  const val = git.chunk[field];
  return typeof val === "number" ? val : undefined;
}

/**
 * Read a chunk-level numeric field (returns 0 for missing — use chunkField for undefined semantics).
 */
function chunkNum(payload: Record<string, unknown>, field: string): number {
  return chunkField(payload, field) ?? 0;
}

/**
 * Check if chunk-level data exists at all.
 */
function hasChunkData(payload: Record<string, unknown>): boolean {
  const git = getGit(payload);
  if (!git) return false;
  if (git.chunk && typeof git.chunk === "object") {
    const { chunk } = git;
    return chunk.commitCount !== undefined;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Blending helpers (compute alpha from payload)
// ---------------------------------------------------------------------------

/**
 * Get alpha from payload's chunk and file commit counts.
 */
function payloadAlpha(payload: Record<string, unknown>): number {
  const chunkCC = chunkField(payload, "commitCount");
  const fileCC = fileNum(payload, "commitCount");
  return computeAlpha(chunkCC, fileCC);
}

/**
 * Blend a file+chunk numeric signal using payload alpha.
 * For signals where chunk-level data may not exist (e.g., ageDays, bugFixRate).
 */
function blendSignal(payload: Record<string, unknown>, field: string): number {
  const fileVal = fileNum(payload, field);
  const alpha = payloadAlpha(payload);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  return blend(chunkVal, fileVal, alpha);
}

// ---------------------------------------------------------------------------
// Signal descriptors (14 total)
// ---------------------------------------------------------------------------

export const gitDerivedSignals: DerivedSignalDescriptor[] = [
  // 1. recency — recent code scores high (L3 alpha-blended)
  {
    name: "recency",
    description: "Inverse of age: recently modified code scores higher. L3 blends chunk+file ageDays.",
    sources: ["ageDays"],
    defaultBound: 365,
    extract(payload, bound) {
      const b = bound ?? 365;
      const effectiveAge = blendSignal(payload, "ageDays");
      return 1 - normalize(effectiveAge, b);
    },
  },

  // 2. stability — low churn scores high (L3 alpha-blended)
  {
    name: "stability",
    description: "Inverse of churn: stable code with few commits scores higher. L3 blends chunk+file commitCount.",
    sources: ["commitCount"],
    defaultBound: 50,
    extract(payload, bound) {
      const b = bound ?? 50;
      const effectiveCC = blendSignal(payload, "commitCount");
      return 1 - normalize(effectiveCC, b);
    },
  },

  // 3. churn — high commit count scores high (L3 alpha-blended)
  {
    name: "churn",
    description: "Direct commit count: frequently changed code scores higher. L3 blends chunk+file commitCount.",
    sources: ["commitCount"],
    defaultBound: 50,
    extract(payload, bound) {
      const b = bound ?? 50;
      const effectiveCC = blendSignal(payload, "commitCount");
      return normalize(effectiveCC, b);
    },
  },

  // 4. age — old code scores high (L3 alpha-blended)
  {
    name: "age",
    description: "Direct age: older code scores higher. L3 blends chunk+file ageDays.",
    sources: ["ageDays"],
    defaultBound: 365,
    extract(payload, bound) {
      const b = bound ?? 365;
      const effectiveAge = blendSignal(payload, "ageDays");
      return normalize(effectiveAge, b);
    },
  },

  // 5. ownership — author concentration (no blending, file-level only)
  {
    name: "ownership",
    description: "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)",
    sources: ["dominantAuthorPct", "authors"],
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      const pct = fileField(payload, "dominantAuthorPct");
      if (typeof pct === "number" && pct > 0) {
        return pct / 100;
      }
      const authors = fileField(payload, "authors");
      if (Array.isArray(authors) && authors.length > 0) {
        if (authors.length === 1) return 1;
        return 1 / authors.length;
      }
      return 0;
    },
  },

  // 6. bugFix — bug fix rate (L3 alpha-blended)
  {
    name: "bugFix",
    description: "Bug fix rate: code with more fix commits scores higher. L3 blends chunk+file bugFixRate.",
    sources: ["bugFixRate"],
    defaultBound: 100,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload, bound) {
      const b = bound ?? 100;
      const effectiveBFR = blendSignal(payload, "bugFixRate");
      return normalize(effectiveBFR, b);
    },
  },

  // 7. volatility — erratic change patterns (file-level only, no blending)
  {
    name: "volatility",
    description: "Churn volatility: code with erratic commit timing scores higher (churnVolatility/60)",
    sources: ["churnVolatility"],
    defaultBound: 60,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload, bound) {
      const b = bound ?? 60;
      return normalize(fileNum(payload, "churnVolatility"), b);
    },
  },

  // 8. density — change density (L3 alpha-blended)
  {
    name: "density",
    description: "Change density: commits per month. L3 blends chunk+file changeDensity.",
    sources: ["changeDensity"],
    defaultBound: 20,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload, bound) {
      const b = bound ?? 20;
      const effectiveDensity = blendSignal(payload, "changeDensity");
      return normalize(effectiveDensity, b);
    },
  },

  // 9. chunkChurn — chunk-level commit count (alpha-dampened, not blended)
  {
    name: "chunkChurn",
    description: "Chunk-level commit count, dampened by alpha (coverage confidence).",
    sources: ["chunk.commitCount"],
    defaultBound: 30,
    extract(payload, bound) {
      const b = bound ?? 30;
      const chunkCC = chunkNum(payload, "commitCount");
      const alpha = payloadAlpha(payload);
      return normalize(chunkCC, b) * alpha;
    },
  },

  // 10. relativeChurnNorm — churn relative to file size (L3 alpha-blended)
  {
    name: "relativeChurnNorm",
    description: "Relative churn: total changes relative to file size. L3 blends chunk+file relativeChurn.",
    sources: ["relativeChurn"],
    defaultBound: 5.0,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload, bound) {
      const b = bound ?? 5.0;
      const effectiveRC = blendSignal(payload, "relativeChurn");
      return normalize(effectiveRC, b);
    },
  },

  // 11. burstActivity — recent burst of changes (L3 alpha-blended)
  {
    name: "burstActivity",
    description: "Recency-weighted commit frequency. L3 blends chunk+file recencyWeightedFreq.",
    sources: ["recencyWeightedFreq"],
    defaultBound: 10.0,
    extract(payload, bound) {
      const b = bound ?? 10.0;
      const effectiveBurst = blendSignal(payload, "recencyWeightedFreq");
      return normalize(effectiveBurst, b);
    },
  },

  // 12. knowledgeSilo — single-contributor risk (L3 alpha-blended contributorCount)
  {
    name: "knowledgeSilo",
    description: "Knowledge silo risk: 1 contributor=1.0, 2=0.5, 3+=0. L3 blends effective contributorCount.",
    sources: ["contributorCount"],
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      const effectiveCount = blendSignal(payload, "contributorCount");
      if (effectiveCount <= 0) return 0;
      if (effectiveCount === 1) return 1.0;
      if (effectiveCount === 2) return 0.5;
      return 0;
    },
  },

  // 13. chunkRelativeChurn — chunk's share of file churn (alpha-dampened, not blended)
  {
    name: "chunkRelativeChurn",
    description: "Chunk churn ratio: chunk's share of file-level churn, dampened by alpha.",
    sources: ["chunk.churnRatio"],
    defaultBound: 1.0,
    extract(payload, bound) {
      const b = bound ?? 1.0;
      const chunkCR = chunkNum(payload, "churnRatio");
      const alpha = payloadAlpha(payload);
      return normalize(chunkCR, b) * alpha;
    },
  },

  // 14. blockPenalty — penalize block chunks with only file-level data
  {
    name: "blockPenalty",
    description: "Data quality discount for block chunks: 1.0 if block without chunk data (alpha=0), 0 otherwise",
    sources: ["chunk.commitCount", "commitCount"],
    extract(payload) {
      const { chunkType } = payload;
      if (chunkType !== "block") return 0;
      // If chunk-level git data exists, compute alpha to determine penalty
      if (hasChunkData(payload)) {
        const alpha = payloadAlpha(payload);
        return 1.0 - alpha;
      }
      // No chunk data at all — full penalty
      return 1.0;
    },
  },
];
