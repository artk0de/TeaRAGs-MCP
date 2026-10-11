/**
 * `adapters/vcs` facade — the one import surface for code outside this
 * adapter. The `VcsGitAdapter` port (built by `VcsAdapterFactory`) is the
 * primary entry; the git-cli free functions exported below are the reads the
 * port does not carry (pre-construction repo-root resolution, working-tree
 * overlay reads, review-scope history). Files under `git/` are internal.
 */

export { VcsAdapterFactory } from "./factory.js";
export { VcsGitAdapter } from "./git/adapter.js";
export { listRepoWorkTrees, resolveGitCommonDir } from "./git/common-dir.js";
export { adoptGitExecutable, buildGitChildProcessEnv, resolveGitExecutable } from "./git/git-executable.js";
export {
  detectDefaultBranch,
  findGitToplevel,
  gitPathFromRoot,
  gitPathPrefix,
  readEnclosingRepoGitState,
  readRepoGitState,
  readWorkingTreeDirty,
  readWorkingTreeDirtyPaths,
  rebaseGitPathsOntoRoot,
  type RepoGitState,
} from "./git/repo-git-state.js";
export { createCatFileBatch, readBlobCommitTime } from "./git/git-cli/cat-file.js";
export { isAncestor, readCommitTime, readMergeBase, resolveRepoRoot } from "./git/git-cli/client.js";
export { reapGitChildProcesses } from "./git/git-cli/git-child-process-registry.js";
export { listCommitsSince, readPathCommitsSince, type PathCommitsSince } from "./git/git-cli/history.js";
export { parseNumstatChangedPath } from "./git/git-cli/parsers.js";
export {
  readAddedLineRangesOfFiles,
  readStatusPorcelain,
  readWorkingTreeChanges,
  readWorkingTreeRenames,
  type AddedLineRange,
} from "./git/git-cli/working-tree.js";
export type {
  BlameLine,
  BlobBatchReader,
  CommitChangedPath,
  CommitFileNumstat,
  CommitInfo,
  CommitPathChanges,
  CommitWithChangedFiles,
  FileChurnData,
  GitAdapterKind,
  OidBatchResolver,
} from "./types.js";
