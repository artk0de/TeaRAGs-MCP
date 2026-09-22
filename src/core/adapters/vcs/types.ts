/**
 * VCS adapter contracts.
 *
 * `VcsAdapter` is the VCS-portable subset — the top-level abstraction a future
 * non-git VCS (hg, jj) would implement. Git-family strengthening (pathspec
 * ops, object-id batch plumbing) lives in `git/adapter.ts` (`VcsGitAdapter`);
 * implementations in `git/cli/` and `git/es-git/`.
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
  parents: string[]; // parent SHAs from %P (merge commits have 2+, root has 0)
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
 * A single line attribution from `git blame --porcelain HEAD -- <file>`.
 * Carries the author of the line as it currently stands in HEAD — the basis for
 * line-based ownership signals.
 */
export interface BlameLine {
  lineNumber: number;
  sha: string;
  author: string;
  authorEmail: string;
  timestamp: number; // unix seconds
}

/**
 * One file a commit touched, addressed by the path it has AS OF THAT COMMIT.
 *
 * `git log --numstat` runs with rename detection ON (`diff.renames` defaults to
 * true since git 2.9), so a renamed file arrives as ONE mangled column —
 * `pre{old => new}post` — rather than as a path. Keeping that string raw made
 * the whole commit invisible to any consumer keyed on current paths
 * (bd tea-rags-mcp-0dwsn): the chunk-churn walk dropped it before reading a
 * blob, and every chunk of the renamed file published `commitCount: 0`.
 *
 * So the parsers split the column instead. `path` is what the file is called
 * at this commit — the key every chunk map, churn map and byFile index uses.
 * `previousPath` is what it was called at the FIRST PARENT, present only when
 * this commit renamed it; reading the parent side of the diff there is what
 * keeps the rename commit credited to the lines it really changed rather than
 * to the whole file.
 */
export interface CommitChangedPath {
  /** Path as of this commit. */
  path: string;
  /** Path at the first parent — set only when this commit renamed the file. */
  previousPath?: string;
}

/** A commit paired with the files it changed (numstat/pathspec log entry). */
export interface CommitWithChangedFiles {
  commit: CommitInfo;
  changedFiles: CommitChangedPath[];
}

/**
 * A commit paired with its per-file numstat (added/deleted line counts).
 * The numstat-preserving sibling of `CommitWithChangedFiles` — that type
 * keeps only file paths; this one keeps the +/- counts a commit-cache needs
 * to evict a commit's contribution and re-aggregate. Binary files (git's
 * `-\t-` numstat columns) are SKIPPED, matching the legacy `parseNumstatOutput`
 * churn map — a binary-only file yields no entry (not `{ added: 0, deleted: 0 }`).
 */
export interface CommitFileNumstat {
  commit: CommitInfo;
  /**
   * Committer epoch seconds (git `%ct`) — distinct from `commit.timestamp`
   * (author date `%at`). `git log --since` windows history by COMMITTER date, so
   * the file-churn discovery MUST evict/sort by this to match the legacy
   * `readNumstatLog` full recompute on rebased / cherry-picked / squash-merged
   * history (author date ≪ committer date). Signal VALUES still read the author
   * date via `commit.timestamp`; this field is windowing/eviction/sort only.
   */
  committerTimestamp: number;
  files: (CommitChangedPath & { added: number; deleted: number })[];
}

/** Closed enum of supported git adapters — the `GIT_ADAPTER` env value space. */
export type GitAdapterKind = "git" | "es-git";

/**
 * Persistent batch blob reader. One long-lived backend resource (a
 * `git cat-file --batch` process on the CLI adapter, an open repository handle
 * in-process) serves many reads; the caller owns the lifecycle and MUST
 * `close()` at the end of the walk. See `.claude/rules/git-cat-file-batch.md`.
 */
export interface BlobBatchReader {
  /** Read `<commitOid>:<filepath>` as a UTF-8 string; "" when absent. */
  read: (commitOid: string, filepath: string) => Promise<string>;
  /** Release the underlying resource and reject any later reads. */
  close: () => Promise<void>;
}

/**
 * Persistent batch OID resolver — resolves `<rev>` strings (e.g.
 * `HEAD:src/a.ts`) to object OIDs, metadata only. Same lifecycle contract as
 * `BlobBatchReader`.
 */
export interface OidBatchResolver {
  /** Resolve `<rev>` (e.g. `HEAD:src/a.ts`) to its object OID; null when the rev is missing. */
  check: (rev: string) => Promise<string | null>;
  /** Release the underlying resource and reject any later checks. */
  close: () => Promise<void>;
}

/**
 * VCS-portable history/content operations, repo-scoped: an instance is bound
 * to one repository root at construction.
 */
export interface VcsAdapter {
  readonly repoRoot: string;
  /** Resolve the current HEAD revision id. */
  getHead: () => Promise<string>;
  /** True iff `ancestor` is an ancestor of `descendant` in the commit graph. */
  isAncestor: (ancestor: string, descendant: string) => Promise<boolean>;
  /** Full-history per-file churn log (numstat), optionally bounded by date. */
  readNumstatLog: (sinceDate?: Date, timeoutMs?: number) => Promise<Map<string, FileChurnData>>;
  /** Commits since a date with their changed files. */
  getCommitsSince: (sinceDate: Date, timeoutMs?: number) => Promise<CommitWithChangedFiles[]>;
  /** Commits in `fromSha..toSha` (incremental discovery top-up). */
  getCommitsInRange: (
    fromSha: string,
    toSha: string,
    sinceDate: Date,
    timeoutMs?: number,
  ) => Promise<CommitWithChangedFiles[]>;
  /** Read a blob at a revision as UTF-8; "" when the path is absent there. */
  readBlobAsString: (commitOid: string, filepath: string) => Promise<string>;
  /** Per-line HEAD attributions; empty array when blame is unavailable. */
  /**
   * `historyDepthHint` = number of commits that touched the file (cheaply known
   * from the numstat churn map). The es-git hybrid uses it to route deep-history
   * files to native `git blame` (libgit2 blame stalls and balloons memory past a
   * depth) and keep shallow ones in-process. Adapters without that split ignore it.
   */
  blameFile: (filePath: string, timeoutMs?: number, historyDepthHint?: number) => Promise<BlameLine[]>;
}
