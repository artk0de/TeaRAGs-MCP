/**
 * Git payload accessors: the ONE git-side reader of the nested
 * (git.file.*, git.chunk.*) and flat (git.*) payload shapes.
 *
 * Lives in the trajectory's infra, not the rerank layer: age-derivation and
 * the derived signals both read these fields, and a git-side home keeps the
 * dependency one-directional — rerank/derived-signals imports trajectory
 * code, never the reverse (bd tea-rags-mcp-nz15d). The rerank layer's import
 * surface for them stays `rerank/derived-signals/helpers.ts`, which
 * re-exports from here.
 *
 * Generic algorithms (computeAlpha, blend, normalize, confidenceDampening)
 * live in contracts/signal-utils.
 */

import { computeAlpha } from "../../../../contracts/signal-utils.js";
import type { SignalLevel } from "../../../../contracts/types/reranker.js";

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
