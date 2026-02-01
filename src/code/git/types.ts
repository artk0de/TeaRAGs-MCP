/**
 * Git Metadata Types - Canonical algorithm implementation
 *
 * Design principles:
 * - One git blame call per file
 * - Cache by content hash (not mtime)
 * - Aggregated signals only (no per-line storage in vector DB)
 * - Task IDs extracted from commit summaries (but full messages not stored)
 */

/**
 * Git blame data for a single line (internal use only)
 */
export interface BlameLineData {
  commit: string;
  author: string;
  authorEmail: string;
  authorTime: number; // Unix timestamp
  /** Task IDs extracted from commit summary (e.g., "TD-1234", "#567") */
  taskIds?: string[];
}

/**
 * Aggregated git metadata for a chunk (stored in vector DB)
 *
 * This is the ONLY git data that gets stored per chunk.
 * Derived from line-level blame via aggregation.
 */
export interface GitChunkMetadata {
  /** Unix timestamp of most recent change in chunk */
  lastModifiedAt: number;
  /** Unix timestamp of oldest change in chunk (first created) */
  firstCreatedAt: number;
  /** Author with most lines in this chunk */
  dominantAuthor: string;
  /** Email of dominant author */
  dominantAuthorEmail: string;
  /** All unique authors who touched this chunk */
  authors: string[];
  /** Number of unique commits touching this chunk (churn indicator) */
  commitCount: number;
  /** Commit hash of the most recent change */
  lastCommitHash: string;
  /** Days since last modification */
  ageDays: number;
  /** Task IDs from commits touching this chunk (e.g., ["TD-1234", "JIRA-567"]) */
  taskIds: string[];
}

/**
 * Cached blame data for a file
 */
export interface BlameCache {
  /** SHA-256 hash of file content */
  contentHash: string;
  /** Line number -> blame data (1-indexed) */
  lines: Map<number, BlameLineData>;
  /** When cache was created */
  cachedAt: number;
}

/**
 * Serializable blame cache for disk storage
 */
export interface BlameCacheFile {
  version: 4;
  contentHash: string;
  cachedAt: number;
  /** Array of [lineNumber, commit, author, authorEmail, authorTime, taskIds] */
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
