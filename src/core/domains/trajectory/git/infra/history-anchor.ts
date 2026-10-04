/**
 * The git history clock (`TRAJECTORY_GIT_ANCHOR`, bd tea-rags-mcp-i6tkc).
 *
 * `now` reads the wall clock at each use — the historical behaviour, kept
 * byte-identical by resolving to `undefined` (every reader then falls back to
 * `Date.now()` exactly as before). `head` reads ONE instant per run, the HEAD
 * commit's committer time, so every window (`--since`, the committer-date
 * evict) and every age / recency value an index run writes is measured from
 * the same point of the repository's own history: two indexes of one commit
 * agree whatever day they were built, and a repository whose last commit is
 * years old still has a populated window.
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { TrajectoryGitConfig } from "../../../../contracts/types/config.js";
import { isDebug } from "../../../../infra/runtime.js";

export type GitHistoryAnchorMode = TrajectoryGitConfig["anchor"];

/**
 * The run's anchor in unix SECONDS, or `undefined` for the wall clock. `head`
 * whose HEAD time cannot be read (no commit, git failure) falls back to the
 * wall clock rather than failing the enrichment.
 */
export async function resolveHistoryAnchorSec(
  adapter: VcsGitAdapter,
  mode: GitHistoryAnchorMode,
  timeoutMs?: number,
): Promise<number | undefined> {
  if (mode !== "head") return undefined;
  try {
    return await adapter.readHeadCommitTime(timeoutMs);
  } catch (error) {
    if (isDebug()) {
      console.error(
        `[GitEnrich] HEAD commit time unreadable, history anchored at the wall clock:`,
        error instanceof Error ? error.message : error,
      );
    }
    return undefined;
  }
}

/** The history clock in epoch MILLISECONDS — `Date.now()` when unanchored. */
export function historyNowMs(anchorSec?: number): number {
  return anchorSec !== undefined ? anchorSec * 1000 : Date.now();
}

/** The `--since` instant of a `maxAgeMonths` window (≤ 0 ⇒ ten years) ending at the history clock. */
export function historyWindowSince(maxAgeMonths: number, anchorSec?: number): Date {
  const effectiveMonths = maxAgeMonths > 0 ? maxAgeMonths : 120;
  return new Date(historyNowMs(anchorSec) - effectiveMonths * 30 * 86400 * 1000);
}
