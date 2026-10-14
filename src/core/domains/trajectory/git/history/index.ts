// Repository-history read primitives (bd tea-rags-mcp-89k7k.35.7): the run-scoped
// commit discovery and its store, the history anchor, rename following, author
// identity and session grouping, and the commit-message rules (taskIds, merge,
// bug-fix). A stable cluster with no dependency on the git enrichment provider —
// the provider, the git walk readers and the codegraph temporal sub-graph all
// consume it through this facade, never by deep import.
export {
  GitCommitDiscovery,
  type GitCommitDiscoveryEntry,
  type GitCommitDiscoveryOptions,
} from "./commit-discovery.js";
export { GitCommitDiscoveryStore } from "./commit-discovery-store.js";
export {
  HISTORY_ANCHOR_ENV_KEY,
  historyWindowSince,
  resolveHistoryAnchorSec,
  resolveIndexHistoryAnchorSec,
  stampedHistoryAnchorMode,
  type GitHistoryAnchorMode,
} from "./history-anchor.js";
export { buildBugFixShaSet } from "./merge-branch-resolver.js";
export { mailmapStampMatches, readMailmapFingerprint } from "./mailmap-fingerprint.js";
export { resolveRepoIdentity } from "./repo-identity.js";
export { pruneSnapshots } from "./snapshot-retention.js";
export {
  aggregateFileChurnFollowingRenames,
  resolveHeadPaths,
  sliceCommitsFollowingRenames,
  type HeadAttributedChangedPath,
} from "./rename-following.js";
export {
  authorIdentityKey,
  buildAuthorNameDirectory,
  canonicalizeAuthorNames,
  tallyAuthors,
  type AuthorNameDirectory,
} from "./author-identity.js";
export { groupIntoSessions, groupTimestampsIntoFixSessions, partitionIntoAuthorSessions } from "./sessions.js";
export { EMPTY_TASK_ID_VOCABULARY, extractTaskIds, learnTaskIdVocabulary, type TaskIdVocabulary } from "./task-ids.js";
export { isBugFixCommit, isBugFixCommitOrBranch, MERGE_SUBJECT } from "./utils.js";
