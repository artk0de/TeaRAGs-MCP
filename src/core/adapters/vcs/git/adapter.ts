/**
 * Git-family strengthening of the VCS-portable contract.
 *
 * Pathspec-filtered discovery and object-id batch plumbing are git semantics,
 * not VCS-generic — they live here, not on `VcsAdapter`. The git trajectory
 * domain and `VcsAdapterFactory` type against THIS class; its implementations
 * (`GitCliAdapter` in `cli/`, `EsGitAdapter` in `es-git/`) are substitutable,
 * enforced behaviorally by the equivalence suite. Logic common to both
 * implementations belongs on this base class, never duplicated in siblings.
 */

import type {
  BlameLine,
  BlobBatchReader,
  CommitWithChangedFiles,
  FileChurnData,
  OidBatchResolver,
  VcsAdapter,
} from "../types.js";

export abstract class VcsGitAdapter implements VcsAdapter {
  constructor(readonly repoRoot: string) {}

  abstract getHead(): Promise<string>;
  abstract isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  abstract readNumstatLog(sinceDate?: Date, timeoutMs?: number): Promise<Map<string, FileChurnData>>;
  abstract getCommitsSince(sinceDate: Date, timeoutMs?: number): Promise<CommitWithChangedFiles[]>;
  abstract getCommitsInRange(
    fromSha: string,
    toSha: string,
    sinceDate: Date,
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]>;
  abstract readBlobAsString(commitOid: string, filepath: string): Promise<string>;
  abstract blameFile(filePath: string, timeoutMs?: number): Promise<BlameLine[]>;

  /** Commits touching `filePaths` (git pathspec semantics), batched internally. */
  abstract getCommitsByPathspec(
    sinceDate: Date,
    filePaths: string[],
    timeoutMs?: number,
  ): Promise<CommitWithChangedFiles[]>;
  /** Persistent batch blob reader — caller owns the lifecycle (`close()` at walk end). */
  abstract createBlobBatchReader(): BlobBatchReader;
  /** Persistent batch `<rev>` → OID resolver — caller owns the lifecycle. */
  abstract createOidBatchResolver(): OidBatchResolver;
}
