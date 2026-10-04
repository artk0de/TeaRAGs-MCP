/**
 * Git-specific payload accessors and blending helpers for derived signals.
 *
 * Supports both nested (git.file.*, git.chunk.*) and flat (git.*) payload formats.
 * Generic algorithms (computeAlpha, blend, normalize, confidenceDampening)
 * live in infra/signal-utils.
 *
 * The payload ACCESSORS (GitLike, getGit, fileField, chunkField, payloadAlpha)
 * live git-side in `git/infra/payload-accessors.ts` and are re-exported here —
 * the rerank layer's one import surface for them. Age-derivation reads the
 * same accessors from their git-side home, so the trajectory never reaches
 * back into the rerank layer (bd tea-rags-mcp-nz15d).
 */

import { blend, normalize } from "../../../../../contracts/signal-utils.js";
import type { SignalLevel } from "../../../../../contracts/types/reranker.js";
import { chunkField, fileField, getGit, payloadAlpha } from "../../infra/payload-accessors.js";

// Re-export generic functions used directly by signal classes
export { blend, computeAlpha, confidenceDampening, normalize } from "../../../../../contracts/signal-utils.js";

// Re-export the git-side payload accessors (bd tea-rags-mcp-nz15d)
export { chunkField, fileField, getGit, payloadAlpha };
export type { GitLike } from "../../infra/payload-accessors.js";

// ---------------------------------------------------------------------------
// Numeric sugar over the git-side accessors
// ---------------------------------------------------------------------------

/** Read a file-level numeric field. */
export function fileNum(payload: Record<string, unknown>, field: string): number {
  const val = fileField(payload, field);
  return typeof val === "number" ? val : 0;
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
// Blending helpers (alpha comes from the git-side payloadAlpha accessor)
// ---------------------------------------------------------------------------

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

/**
 * Like {@link blendNormalized} but applies a per-scope confidence multiplier to
 * each side BEFORE blending: the chunk component is trusted by `dampChunk`
 * (chunk-scope support), the file component by `dampFile` (file-scope support).
 * This keeps each scope's contribution tied to its own sample size — a low-N
 * chunk inside a high-commit file no longer inherits the file's confidence.
 *
 * Pure-file (alpha=0) returns `fileVal_norm * dampFile`, byte-identical to the
 * legacy `blendNormalized(...) * dampFile` path.
 */
export function blendNormalizedDamped(
  payload: Record<string, unknown>,
  field: string,
  fileBound: number,
  chunkBound: number,
  signalLevel: SignalLevel | undefined,
  dampFile: number,
  dampChunk: number,
): number {
  const fileNorm = normalize(fileNum(payload, field), fileBound);
  const alpha = payloadAlpha(payload, signalLevel);
  if (alpha === 0) return fileNorm * dampFile;
  const chunkVal = chunkField(payload, field);
  const chunkNorm = chunkVal !== undefined ? normalize(chunkVal, chunkBound) : fileNorm;
  return blend(chunkNorm * dampChunk, fileNorm * dampFile, alpha);
}
