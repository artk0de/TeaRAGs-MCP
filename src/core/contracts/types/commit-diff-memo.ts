/**
 * Run-scoped memo of per-(commitSha, filePath) diff hunks.
 *
 * The concrete memo is created per indexing run by the ingest chunk-enrichment
 * phase and consumed by the git trajectory's commit walk. Both sides depend on
 * this port instead of on each other — otherwise the shape has to be redeclared
 * by value in every module that touches it, which is exactly what happened
 * before (three copies: infra, contracts/types/provider.ts, walk-commits.ts).
 */

/** Structural hunk shape — matches `diff`'s structuredPatch hunks (positions only). */
export interface CommitDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

/**
 * Memo surface the walk uses. An empty array is a VALID memoized value (root
 * commit / identical or empty blobs / patch failure); `undefined` means the
 * pair was never computed.
 */
export interface CommitDiffMemoPort {
  get: (commitSha: string, filePath: string) => CommitDiffHunk[] | undefined;
  set: (commitSha: string, filePath: string, hunks: CommitDiffHunk[]) => void;
}
