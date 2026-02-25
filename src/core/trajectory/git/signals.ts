/**
 * Git signal descriptors for reranking
 *
 * Extracts all 14 git-specific signals from search result payloads
 * into self-contained SignalDescriptor objects. Each descriptor knows
 * how to read from both nested (git.file.*) and flat (git.*) formats.
 */

import type { SignalDescriptor } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a value to 0-1 range, clamped.
 */
function normalize(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/**
 * Compute alpha blending factor for chunk-vs-file data quality.
 * alpha = 0 means only file data available (chunk data absent/unreliable).
 * alpha = 1 means chunk data is as rich as file data.
 */
function computeAlpha(chunkCommitCount: number | undefined, fileCommitCount: number | undefined): number {
  if (chunkCommitCount === undefined || chunkCommitCount <= 0) return 0;
  if (fileCommitCount === undefined || fileCommitCount <= 0) return 0;
  return Math.min(1, chunkCommitCount / fileCommitCount);
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
 * Read a chunk-level numeric field from git.chunk.<field>.
 */
function chunkNum(payload: Record<string, unknown>, field: string): number {
  const git = getGit(payload);
  if (!git) return 0;
  if (git.chunk && typeof git.chunk === "object" && field in git.chunk) {
    const val = git.chunk[field];
    return typeof val === "number" ? val : 0;
  }
  return 0;
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
// Signal descriptors (14 total)
// ---------------------------------------------------------------------------

export const gitSignals: SignalDescriptor[] = [
  // 1. recency — recent code scores high
  {
    name: "recency",
    description: "Inverse of age: recently modified code scores higher (1 - ageDays/365)",
    defaultBound: 365,
    extract(payload) {
      return 1 - normalize(fileNum(payload, "ageDays"), 365);
    },
  },

  // 2. stability — low churn scores high
  {
    name: "stability",
    description: "Inverse of churn: stable code with few commits scores higher (1 - commitCount/50)",
    defaultBound: 50,
    extract(payload) {
      return 1 - normalize(fileNum(payload, "commitCount"), 50);
    },
  },

  // 3. churn — high commit count scores high
  {
    name: "churn",
    description: "Direct commit count: frequently changed code scores higher (commitCount/50)",
    defaultBound: 50,
    extract(payload) {
      return normalize(fileNum(payload, "commitCount"), 50);
    },
  },

  // 4. age — old code scores high
  {
    name: "age",
    description: "Direct age: older code scores higher (ageDays/365)",
    defaultBound: 365,
    extract(payload) {
      return normalize(fileNum(payload, "ageDays"), 365);
    },
  },

  // 5. ownership — author concentration
  {
    name: "ownership",
    description: "Author concentration: single-owner code scores higher (dominantAuthorPct or 1/authors)",
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

  // 6. bugFix — bug fix rate
  {
    name: "bugFix",
    description: "Bug fix rate: code with more fix commits scores higher (bugFixRate/100)",
    defaultBound: 100,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      return normalize(fileNum(payload, "bugFixRate"), 100);
    },
  },

  // 7. volatility — erratic change patterns
  {
    name: "volatility",
    description: "Churn volatility: code with erratic commit timing scores higher (churnVolatility/60)",
    defaultBound: 60,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      return normalize(fileNum(payload, "churnVolatility"), 60);
    },
  },

  // 8. density — change density (commits/month)
  {
    name: "density",
    description: "Change density: code with more commits per month scores higher (changeDensity/20)",
    defaultBound: 20,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      return normalize(fileNum(payload, "changeDensity"), 20);
    },
  },

  // 9. chunkChurn — chunk-level commit count
  {
    name: "chunkChurn",
    description: "Chunk-level commit count normalized (chunk.commitCount/30)",
    defaultBound: 30,
    extract(payload) {
      return normalize(chunkNum(payload, "commitCount"), 30);
    },
  },

  // 10. relativeChurnNorm — churn relative to file size
  {
    name: "relativeChurnNorm",
    description: "Relative churn: total changes relative to file size (relativeChurn/5.0)",
    defaultBound: 5.0,
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      return normalize(fileNum(payload, "relativeChurn"), 5.0);
    },
  },

  // 11. burstActivity — recent burst of changes
  {
    name: "burstActivity",
    description: "Recency-weighted commit frequency: recent bursts of activity (recencyWeightedFreq/10)",
    defaultBound: 10.0,
    extract(payload) {
      return normalize(fileNum(payload, "recencyWeightedFreq"), 10.0);
    },
  },

  // 12. knowledgeSilo — single-contributor risk
  {
    name: "knowledgeSilo",
    description: "Knowledge silo risk: 1 contributor=1.0, 2=0.5, 3+=0 (categorical)",
    needsConfidence: true,
    confidenceField: "commitCount",
    extract(payload) {
      const count = fileNum(payload, "contributorCount");
      if (count <= 0) return 0;
      if (count === 1) return 1.0;
      if (count === 2) return 0.5;
      return 0;
    },
  },

  // 13. chunkRelativeChurn — chunk's share of file churn
  {
    name: "chunkRelativeChurn",
    description: "Chunk churn ratio: chunk's share of file-level churn (chunk.churnRatio/1.0)",
    defaultBound: 1.0,
    extract(payload) {
      return normalize(chunkNum(payload, "churnRatio"), 1.0);
    },
  },

  // 14. blockPenalty — penalize block chunks with only file-level data
  {
    name: "blockPenalty",
    description: "Data quality discount for block chunks: 1.0 if block without chunk data (alpha=0), 0 otherwise",
    extract(payload) {
      const { chunkType } = payload;
      if (chunkType !== "block") return 0;
      // If chunk-level git data exists, compute alpha to determine penalty
      if (hasChunkData(payload)) {
        const chunkCC = chunkNum(payload, "commitCount");
        const fileCC = fileNum(payload, "commitCount");
        const alpha = computeAlpha(chunkCC, fileCC);
        return 1.0 - alpha;
      }
      // No chunk data at all — full penalty
      return 1.0;
    },
  },
];
