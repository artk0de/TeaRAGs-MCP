/**
 * Git enrichment output types — computed from git history.
 *
 * Design principles:
 * - File-level git metadata (no per-line blame)
 * - All metrics derived from git log (CLI primary, isomorphic-git for object reads)
 * - Research-backed churn metrics (Nagappan & Ball 2005)
 */

import type { ChunkSignalOverlay, FileSignalOverlay } from "../../../contracts/index.js";

/**
 * File-level git signals (stored in vector DB for all chunks of a file)
 *
 * All chunks of a file share the same GitFileSignals.
 */
export interface GitFileSignals extends FileSignalOverlay {
  // Authorship (file-level):
  /** Author with most commits to this file */
  dominantAuthor: string;
  /** Email of dominant author */
  dominantAuthorEmail: string;
  /** All unique authors who touched this file */
  authors: string[];
  /** Percentage of commits by dominant author */
  dominantAuthorPct: number;

  // Temporal:
  /** Unix timestamp of most recent commit */
  lastModifiedAt: number;
  /** Unix timestamp of first commit */
  firstCreatedAt: number;
  /** Commit hash of the most recent change */
  lastCommitHash: string;
  /** Days since last modification */
  ageDays: number;

  // Real churn (from git log):
  /** Total commits touching this file */
  commitCount: number;
  /** Total lines added across all commits */
  linesAdded: number;
  /** Total lines deleted across all commits */
  linesDeleted: number;
  /** Total lines churned (added + deleted) across all commits. Absolute measure of change volume. */
  fileChurnCount: number;
  /** (linesAdded + linesDeleted) / currentLines */
  relativeChurn: number;
  /** Σ exp(-0.1 × daysAgo) — recency-weighted commit frequency */
  recencyWeightedFreq: number;
  /** commits / months — average change density */
  changeDensity: number;
  /** stddev(days between commits) — volatility of change pattern */
  churnVolatility: number;

  // Derived:
  /** Percentage of commits with fix/bug/hotfix/patch keywords (0-100) */
  bugFixRate: number;
  /** Number of unique contributors (= authors.length, explicit for filtering) */
  contributorCount: number;

  // Tickets:
  /** Task IDs extracted from commit messages (e.g., ["TD-1234", "#567"]) */
  taskIds: string[];

  // Line-based ownership (from `git blame HEAD`):
  /** Author owning the largest share of live lines in HEAD */
  lineDominantAuthor: string;
  /** Percentage of live lines owned by lineDominantAuthor (0-100) */
  lineDominantAuthorPct: number;
  /** Top-N contributors to live lines, sorted by share desc */
  lineAuthors: string[];
  /** Distinct authors of live lines */
  lineContributorCount: number;
}

/**
 * Chunk-level churn overlay — computed by diffing commit trees and
 * mapping hunks to chunk line ranges.
 *
 * Applied on top of file-level GitFileSignals to provide per-chunk granularity.
 */
export interface ChunkChurnOverlay extends ChunkSignalOverlay {
  /** Commits that touched lines of this specific chunk */
  commitCount: number;
  /** commitCount / file.commitCount (0-1) */
  churnRatio: number;
  /** Unique authors who modified this specific chunk */
  contributorCount: number;
  /** Percentage of bug-fix commits for this chunk (0-100) */
  bugFixRate: number;
  /** Unix timestamp of last modification to this chunk */
  lastModifiedAt: number;
  /** Days since last modification to this chunk. Undefined when no git history. */
  ageDays?: number;
  /** (linesAdded + linesDeleted) / chunkLineCount — relative churn within chunk */
  relativeChurn: number;
  /** Σ exp(-0.1 × daysAgo) — recency-weighted commit frequency for chunk */
  recencyWeightedFreq: number;
  /** Chunk-level change density (commits per month) */
  changeDensity: number;
  /** Standard deviation of commit intervals for this chunk (days) */
  churnVolatility: number;
  /** Task IDs extracted from commit messages touching this chunk */
  taskIds: string[];

  // Line-based ownership for this chunk's range (from `git blame HEAD`):
  /** Author owning the largest share of live lines inside the chunk's range */
  lineDominantAuthor: string;
  /** Percentage of chunk's live lines owned by lineDominantAuthor (0-100) */
  lineDominantAuthorPct: number;
  /** Top-N contributors to the chunk's live lines, sorted by share desc */
  lineAuthors: string[];
  /** Distinct authors of the chunk's live lines */
  lineContributorCount: number;
}
