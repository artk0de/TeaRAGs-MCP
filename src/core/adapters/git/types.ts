/**
 * Basic git data types used across the application.
 * Low-level — no enrichment concepts.
 */

/** Raw numstat entry from `git log --numstat` */
export interface RawNumstatEntry {
  added: number;
  deleted: number;
  filePath: string;
}

/**
 * Commit info extracted from git log
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
