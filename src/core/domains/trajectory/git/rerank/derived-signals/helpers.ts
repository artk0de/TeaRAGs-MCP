/**
 * Git-specific payload accessors and blending helpers for derived signals.
 *
 * Supports both nested (git.file.*, git.chunk.*) and flat (git.*) payload formats.
 * Generic algorithms (computeAlpha, blend, normalize, confidenceDampening)
 * live in infra/signal-utils.
 */

import type { SignalLevel } from "../../../../../contracts/types/reranker.js";
import { blend, computeAlpha, normalize } from "../../../../../infra/signal-utils.js";

// Re-export generic functions used directly by signal classes
export { blend, computeAlpha, confidenceDampening, normalize } from "../../../../../infra/signal-utils.js";
// Re-export git constants
export { GIT_FILE_DAMPENING } from "../constants.js";

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

/** Get alpha from payload's chunk and file commit counts. Returns 0 when signalLevel is "file". */
export function payloadAlpha(payload: Record<string, unknown>, signalLevel?: SignalLevel): number {
  if (signalLevel === "file") return 0;
  const chunkCC = chunkField(payload, "commitCount");
  if (chunkCC === undefined || chunkCC <= 0) return 0;

  // Distinguish "file data absent" from "fileCount = 0":
  // fileField returns undefined when git.file.commitCount doesn't exist,
  // meaning chunk-only payload → trust chunk data fully (alpha = 1).
  const rawFileCC = fileField(payload, "commitCount");
  if (rawFileCC === undefined) return 1;

  const fileCC = typeof rawFileCC === "number" ? rawFileCC : 0;
  return computeAlpha(chunkCC, fileCC);
}

/**
 * Blend a file+chunk numeric signal using payload alpha.
 * For signals where chunk-level data may not exist (e.g., ageDays, bugFixRate).
 */
export function blendSignal(payload: Record<string, unknown>, field: string, signalLevel?: SignalLevel): number {
  const fileVal = fileNum(payload, field);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  return blend(chunkVal, fileVal, alpha);
}

/**
 * Normalize file and chunk values with per-source bounds, then alpha-blend.
 * Each source is normalized to its own distribution before blending.
 */
export function blendNormalized(
  payload: Record<string, unknown>,
  field: string,
  fileBound: number,
  chunkBound: number,
  signalLevel?: SignalLevel,
): number {
  const fileVal = normalize(fileNum(payload, field), fileBound);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileVal;
  const chunkVal = chunkField(payload, field);
  const normalizedChunk = chunkVal !== undefined ? normalize(chunkVal, chunkBound) : fileVal;
  return blend(normalizedChunk, fileVal, alpha);
}
