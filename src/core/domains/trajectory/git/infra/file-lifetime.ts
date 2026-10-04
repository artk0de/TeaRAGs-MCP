/**
 * Exact age stamps for a file the file walk's window holds no commit for (bd
 * tea-rags-mcp-i6tkc).
 *
 * Every `git.file` COUNTER is a window figure: a file untouched for longer than
 * `logMaxAgeMonths` has zero commits in it, and that zero is the observation.
 * Its AGE is not a window figure — "last changed 700 days ago" is exactly what
 * a reader of a dormant file needs, and the window cannot say it. So the age
 * stamps come from the whole history, through a log that names paths and
 * nothing else (`VcsGitAdapter#readCommitPathChanges`): no numstat, so no blob
 * diffs, which is what made the old lifetime backfill a 5–10 s walk per
 * 500-path batch on a 26.7k-commit repository.
 *
 * One repo-wide read serves every path of a run; the fold follows renames
 * through the same alias map the churn aggregate uses (`resolveHeadPaths`), so
 * a file moved 700 days ago and created 900 days ago under its old name reads
 * `firstCreatedAt` 900 days ago.
 */

import type { VcsGitAdapter } from "../../../../adapters/vcs/git/adapter.js";
import type { CommitPathChanges, FileChurnData } from "../../../../adapters/vcs/types.js";
import { resolveHeadPaths } from "./rename-following.js";

/** A file's whole-history age stamps, unix seconds of the AUTHOR date. */
export interface FileLifetimeStamps {
  /** Newest commit touching the file under any of its names. */
  lastModifiedAt: number;
  /** Oldest commit touching the file under any of its names. */
  firstCreatedAt: number;
  /** Sha of the commit `lastModifiedAt` reads. */
  lastCommitHash: string;
}

/**
 * The file walk's churn for one path. `lifetime` is present exactly when the
 * window holds no commit for the path: the counters are then the zero
 * observation and the age stamps come from `lifetime`.
 */
export type WindowedFileChurn = FileChurnData & { readonly lifetime?: FileLifetimeStamps };

/**
 * Fold a newest → oldest path log into per-HEAD-path age stamps. A file that
 * does not survive to HEAD stays keyed under the last name it had, as the churn
 * aggregate keys it; callers look up HEAD paths only. Among commits sharing the
 * newest author second, the one first in log order names `lastCommitHash`.
 */
export function foldFileLifetimeStamps(entries: readonly CommitPathChanges[]): Map<string, FileLifetimeStamps> {
  const attributed = resolveHeadPaths(entries);
  const stamps = new Map<string, FileLifetimeStamps>();
  entries.forEach((entry, i) => {
    for (const { headPath } of attributed[i]) {
      const known = stamps.get(headPath);
      if (!known) {
        stamps.set(headPath, {
          lastModifiedAt: entry.timestamp,
          firstCreatedAt: entry.timestamp,
          lastCommitHash: entry.sha,
        });
        continue;
      }
      if (entry.timestamp > known.lastModifiedAt) {
        known.lastModifiedAt = entry.timestamp;
        known.lastCommitHash = entry.sha;
      }
      if (entry.timestamp < known.firstCreatedAt) known.firstCreatedAt = entry.timestamp;
    }
  });
  return stamps;
}

/** Whole-history age stamps of every path HEAD's history touched — one `git log --name-status`. */
export async function readFileLifetimeStamps(
  adapter: VcsGitAdapter,
  timeoutMs: number,
): Promise<Map<string, FileLifetimeStamps>> {
  return foldFileLifetimeStamps(await adapter.readCommitPathChanges(timeoutMs));
}

/**
 * `windowed` plus a zero-observation entry for every path of `paths` the window
 * holds nothing for but the history does. A path no commit ever touched (an
 * untracked file) stays absent. Mutates and returns `windowed`.
 */
export function addDormantFileChurn(
  windowed: Map<string, WindowedFileChurn>,
  paths: readonly string[],
  lifetime: ReadonlyMap<string, FileLifetimeStamps>,
): Map<string, WindowedFileChurn> {
  for (const path of paths) {
    if (windowed.has(path)) continue;
    const stamps = lifetime.get(path);
    if (stamps) windowed.set(path, { commits: [], linesAdded: 0, linesDeleted: 0, lifetime: { ...stamps } });
  }
  return windowed;
}
