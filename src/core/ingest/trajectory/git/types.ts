/**
 * Git Metadata Types
 *
 * Design principles:
 * - File-level git metadata (no per-line blame)
 * - All metrics derived from git log (CLI primary, isomorphic-git for object reads)
 * - Research-backed churn metrics (Nagappan & Ball 2005)
 */

/**
 * Commit info extracted from git log (used by GitLogReader)
 */
export interface CommitInfo {
  sha: string;
  author: string;
  authorEmail: string;
  timestamp: number; // unix seconds
  body: string; // full commit message (for taskId extraction)
}

/**
 * Per-file churn data aggregated from git log
 */
export interface FileChurnData {
  commits: CommitInfo[];
  linesAdded: number;
  linesDeleted: number;
}

/**
 * File-level git metadata (stored in vector DB for all chunks of a file)
 *
 * Replaces per-chunk blame-based GitChunkMetadata.
 * All chunks of a file share the same GitFileMetadata.
 */
export interface GitFileMetadata {
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
}

/**
 * Chunk-level churn overlay — computed by diffing commit trees and
 * mapping hunks to chunk line ranges.
 *
 * Applied on top of file-level GitFileMetadata to provide per-chunk granularity.
 */
export interface ChunkChurnOverlay {
  /** Commits that touched lines of this specific chunk */
  chunkCommitCount: number;
  /** chunkCommitCount / file.commitCount (0-1) */
  chunkChurnRatio: number;
  /** Unique authors who modified this specific chunk */
  chunkContributorCount: number;
  /** Percentage of bug-fix commits for this chunk (0-100) */
  chunkBugFixRate: number;
  /** Unix timestamp of last modification to this chunk */
  chunkLastModifiedAt: number;
  /** Days since last modification to this chunk */
  chunkAgeDays: number;
}

/**
 * Git repository information
 */
export interface GitRepoInfo {
  repoRoot: string;
  isGitRepo: boolean;
}
