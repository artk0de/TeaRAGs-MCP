/**
 * Churn-walk thread protocol — pure serializable types (bd tea-rags-mcp-iqpuu).
 *
 * Worker-thread DI per `.claude/rules/domains-language.md`: class INSTANCES
 * never cross `postMessage` (structured clone drops prototype methods and
 * native handles). The main side ships a fully-serializable job — the
 * pre-sliced discovery rows, blame/churn slices, and scalar config — and the
 * worker owns its own run-scoped instances (CatFileBatchReader per repoRoot,
 * CommitDiffMemo, Semaphore). Every value below is structured-clone-safe:
 * Map / Set / plain objects / numbers / strings / booleans.
 */

import type { BlameLine, CommitInfo, FileChurnData, GitAdapterKind } from "../../../../../adapters/vcs/types.js";
import type { ChunkLookupEntry } from "../../../../../types.js";
import type { ChunkChurnOverlay } from "../../types.js";
import type { SquashOptions } from "../metrics.js";
import type { ChunkChurnWalkStats } from "../walk-commits.js";

/** One serializable walk job — everything the worker needs for one batch. */
export interface ChunkChurnWalkJobInput {
  repoRoot: string;
  /** Adapter KIND (structured-clone-safe literal) — the worker rebuilds its
   *  own VcsGitAdapter in-thread via VcsAdapterFactory (worker-DI). */
  gitAdapter: GitAdapterKind;
  /** Repo-relative path → chunk entries (relativized on the main side). */
  relativeChunkMap: Map<string, ChunkLookupEntry[]>;
  /** Pre-sliced discovery rows for this batch (main side queried the matrix). */
  commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
  bugFixShas: Set<string>;
  /** Blame slice for this batch's files (chunk-range ownership fields). */
  blameByPath: Map<string, BlameLine[]>;
  /** File-churn slice for this batch's files (churnRatio denominator). */
  fileChurnData?: Map<string, FileChurnData>;
  squashOpts?: SquashOptions;
  concurrency: number;
  maxAgeMonths: number;
  chunkTimeoutMs: number;
  maxFileLines: number;
  /**
   * Mirrors options.concurrencySemaphore presence on the inline path:
   * true => the worker's shared limiter bounds this walk; false =>
   * walkCommits' internal per-walk limiter.
   */
  useSharedLimiter: boolean;
}

/** Walk result crossing back to the main thread. */
export interface ChunkChurnWalkOutcome {
  overlays: Map<string, Map<string, ChunkChurnOverlay>>;
  stats: ChunkChurnWalkStats;
}

export type ChurnWalkThreadRequest = { type: "walk"; id: number; job: ChunkChurnWalkJobInput } | { type: "close" };

export type ChurnWalkThreadResponse =
  | { type: "walked"; id: number; overlays: ChunkChurnWalkOutcome["overlays"]; stats: ChunkChurnWalkStats }
  | { type: "walk-failed"; id: number; error: string };
