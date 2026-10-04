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

/**
 * The registry env key an index run stamps its anchor mode under. The read
 * path takes the mode from the INDEX, never from the serving process: the
 * query clock has to be the one the stored ages were measured from.
 */
export const HISTORY_ANCHOR_ENV_KEY = "TRAJECTORY_GIT_ANCHOR";

/**
 * The anchor mode an index was STAMPED with (bd tea-rags-mcp-zwu7m). Only an
 * explicit `head` reads `head`: an absent snapshot, an absent key (every index
 * built before i6tkc) and any other value are `now`, the default.
 */
export function stampedHistoryAnchorMode(env: Readonly<Record<string, string>> | undefined): GitHistoryAnchorMode {
  return env?.[HISTORY_ANCHOR_ENV_KEY] === "head" ? "head" : "now";
}

/**
 * The QUERY-time anchor of an index in unix SECONDS, or `undefined` for the
 * wall clock (bd tea-rags-mcp-zwu7m). A `head` index measured every stored age
 * from its HEAD at index time — the commit the index was built at — so a read
 * measures from that commit's committer time, not from the checkout's current
 * HEAD. `now`, no indexed commit, or a time that cannot be read (the commit is
 * gone, git fails) → the wall clock: a query never fails on its clock.
 */
export async function resolveIndexHistoryAnchorSec(
  mode: GitHistoryAnchorMode,
  indexedCommit: string | undefined,
  readCommitTime: (commit: string) => Promise<number>,
): Promise<number | undefined> {
  if (mode !== "head") return undefined;
  if (indexedCommit === undefined || indexedCommit === "") {
    if (isDebug()) console.error(`[HistoryAnchor] head-anchored index has no indexed commit, read at the wall clock`);
    return undefined;
  }
  try {
    return await readCommitTime(indexedCommit);
  } catch (error) {
    if (isDebug()) {
      console.error(
        `[HistoryAnchor] indexed commit ${indexedCommit.slice(0, 7)} has no readable time, read at the wall clock:`,
        error instanceof Error ? error.message : error,
      );
    }
    return undefined;
  }
}
