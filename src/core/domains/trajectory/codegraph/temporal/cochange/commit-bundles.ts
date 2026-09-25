/**
 * Commit bundling — the unit of co-change (bd tea-rags-mcp-x4rpp, spec open
 * question 4).
 *
 * A bundle is what "changed together" means: one commit, or — with the git
 * trajectory's squash-aware sessions on — one author session, grouped by the
 * SAME rule (`partitionIntoAuthorSessions`), so the two trajectories never
 * disagree about what a session is. The 9szed gate measured that session
 * bundling costs forgotten-change recall on taxdome (27.57% vs 29.44% top-3),
 * because a session erases short-range pairs; it follows the configured
 * `TRAJECTORY_GIT_SQUASH_AWARE_SESSIONS` rather than being forced on, so an
 * agent-burst repository can opt in and every other stays per-commit.
 */

import type { CommitInfo } from "../../../../../adapters/vcs/types.js";
import type { RelPath } from "../../../../../contracts/types/codegraph.js";
import { partitionIntoAuthorSessions } from "../../../git/index.js";

/** One scoped commit: the files it touched, as project-relative HEAD paths, each once. */
export interface CochangeCommit {
  commit: CommitInfo;
  files: RelPath[];
}

/** Files that changed together, with the commits that changed them. */
export interface CochangeBundle {
  /** Member commit SHAs, oldest first — the last one is the bundle's newest. */
  shas: string[];
  /** Unix seconds of the newest member. */
  timestamp: number;
  /** Distinct files, code-point sorted. */
  files: RelPath[];
}

/**
 * Bundle scoped commits, oldest bundle first. `sessionGapMinutes === null` →
 * one bundle per commit; a number → one per (author, gap) session.
 */
export function bundleCochangeCommits(
  commits: readonly CochangeCommit[],
  sessionGapMinutes: number | null,
): CochangeBundle[] {
  const groups =
    sessionGapMinutes === null
      ? [...commits].sort((a, b) => a.commit.timestamp - b.commit.timestamp).map((c) => [c])
      : partitionIntoAuthorSessions(commits, (c) => c.commit, sessionGapMinutes);
  return groups.map((members) => ({
    shas: members.map((m) => m.commit.sha),
    timestamp: members[members.length - 1].commit.timestamp,
    files: [...new Set(members.flatMap((m) => m.files))].sort(compareCodePoints),
  }));
}

/** Locale-independent, so every machine orders paths the same way. */
export function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
