/**
 * Shared helpers for git derived signal extraction.
 *
 * Supports both nested (git.file.*, git.chunk.*) and flat (git.*) payload formats.
 * Provides L3 alpha-blending: when chunk-level data exists, signals blend
 * chunk + file values weighted by alpha (coverage x maturity).
 */

import type { DampeningConfig } from "../../../../contracts/types/trajectory.js";

/** Shared dampening config for all file-level git derived signals. */
export const GIT_FILE_DAMPENING: DampeningConfig = { key: "git.file.commitCount", percentile: 25 };

/** Minimum chunk commits for full maturity in alpha computation */
export const CHUNK_MATURITY_THRESHOLD = 3;

/**
 * Compute alpha blending factor for chunk-vs-file data quality.
 * alpha = coverageRatio x maturity, clamped to [0, 1].
 *   coverageRatio = chunkCommitCount / fileCommitCount
 *   maturity = min(1, chunkCommitCount / CHUNK_MATURITY_THRESHOLD)
 *
 * Maturity prevents low-commit chunks (1-2 commits) from overriding
 * reliable file-level statistics.
 */
export function computeAlpha(chunkCommitCount: number | undefined, fileCommitCount: number | undefined): number {
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
export function blend(chunkValue: number | undefined, fileValue: number, alpha: number): number {
  if (chunkValue === undefined) return fileValue;
  return alpha * chunkValue + (1 - alpha) * fileValue;
}

// ---------------------------------------------------------------------------
// Payload accessors (support nested and flat formats)
// ---------------------------------------------------------------------------

export interface GitLike {
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Safely extract the git object from the payload. */
export function getGit(payload: Record<string, unknown>): GitLike | undefined {
  const { git } = payload;
  if (git && typeof git === "object") return git as GitLike;
  return undefined;
}

/** Read a file-level field, checking nested first then flat. */
export function fileField(payload: Record<string, unknown>, field: string): unknown {
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

/** Read a file-level numeric field. */
export function fileNum(payload: Record<string, unknown>, field: string): number {
  const val = fileField(payload, field);
  return typeof val === "number" ? val : 0;
}

/**
 * Read a chunk-level field, returning undefined if absent.
 * Distinguishes between "field missing" and "field = 0" for correct blend semantics.
 */
export function chunkField(payload: Record<string, unknown>, field: string): number | undefined {
  const git = getGit(payload);
  if (!git?.chunk || typeof git.chunk !== "object") return undefined;
  if (!(field in git.chunk)) return undefined;
  const val = git.chunk[field];
  return typeof val === "number" ? val : undefined;
}

/**
 * Read a chunk-level numeric field (returns 0 for missing — use chunkField for undefined semantics).
 */
export function chunkNum(payload: Record<string, unknown>, field: string): number {
  return chunkField(payload, field) ?? 0;
}

/** Check if chunk-level data exists at all. */
export function hasChunkData(payload: Record<string, unknown>): boolean {
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

/** Get alpha from payload's chunk and file commit counts. */
export function payloadAlpha(payload: Record<string, unknown>): number {
  const chunkCC = chunkField(payload, "commitCount");
  const fileCC = fileNum(payload, "commitCount");
  return computeAlpha(chunkCC, fileCC);
}

/**
 * Blend a file+chunk numeric signal using payload alpha.
 * For signals where chunk-level data may not exist (e.g., ageDays, bugFixRate).
 */
export function blendSignal(payload: Record<string, unknown>, field: string): number {
  const fileVal = fileNum(payload, field);
  const alpha = payloadAlpha(payload);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  return blend(chunkVal, fileVal, alpha);
}

// ---------------------------------------------------------------------------
// Confidence dampening
// ---------------------------------------------------------------------------

const CONFIDENCE_POWER = 2;

/**
 * Quadratic confidence dampening.
 * Returns 1 when effectiveCommitCount >= threshold, otherwise (n/k)^2.
 */
export function confidenceDampening(effectiveCommitCount: number, threshold: number): number {
  if (threshold <= 0) return 1;
  if (effectiveCommitCount >= threshold) return 1;
  return Math.pow(effectiveCommitCount / threshold, CONFIDENCE_POWER);
}
