/**
 * Git Metadata Types
 *
 * Design principles:
 * - File-level git metadata (no per-line blame)
 * - All metrics derived from git log via isomorphic-git
 * - Research-backed churn metrics (Nagappan & Ball 2005)
 * - 0 process spawns — direct .git reading
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
 * @deprecated Use GitFileMetadata instead. Kept for backward compatibility with existing tests.
 * Aggregated git metadata for a chunk (was stored in vector DB)
 */
export interface GitChunkMetadata {
  lastModifiedAt: number;
  firstCreatedAt: number;
  dominantAuthor: string;
  dominantAuthorEmail: string;
  authors: string[];
  commitCount: number;
  lastCommitHash: string;
  ageDays: number;
  taskIds: string[];
}

/**
 * @deprecated Blame-based caching is no longer used. Kept for type compatibility.
 */
export interface BlameLineData {
  commit: string;
  author: string;
  authorEmail: string;
  authorTime: number;
  taskIds?: string[];
}

/**
 * @deprecated Blame-based caching is no longer used. Kept for type compatibility.
 */
export interface BlameCache {
  contentHash: string;
  lines: Map<number, BlameLineData>;
  cachedAt: number;
}

/**
 * @deprecated Blame-based caching is no longer used. Kept for type compatibility.
 */
export interface BlameCacheFile {
  version: 4;
  contentHash: string;
  cachedAt: number;
  lines: Array<[number, string, string, string, number, string[]]>;
}

/**
 * Git repository information
 */
export interface GitRepoInfo {
  repoRoot: string;
  isGitRepo: boolean;
}

/**
 * Options for git metadata service
 */
export interface GitMetadataOptions {
  /** Cache directory (default: ~/.tea-rags-mcp/git-cache) */
  cacheDir?: string;
  /** Enable debug logging */
  debug?: boolean;
}
