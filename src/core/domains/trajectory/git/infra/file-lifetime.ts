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

import type { CommitPathChanges, FileChurnData, VcsGitAdapter } from "../../../../adapters/vcs/index.js";
import { resolveHeadPaths } from "../history/index.js";
import type { GitFileLifetimeStore } from "./file-lifetime-store.js";

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
 * observation and the age stamps come from `lifetime`. `historyAnchorSec` is the
 * instant ages and recency are measured from when the run is anchored
 * (`history-anchor.ts`); absent ⇒ the wall clock at assembly.
 */
export type WindowedFileChurn = FileChurnData & {
  readonly lifetime?: FileLifetimeStamps;
  readonly historyAnchorSec?: number;
};

/**
 * Stamp the run's history anchor onto every entry — a COPY per entry, so the
 * run-scoped discovery's shared objects stay unanchored. Unanchored
 * (`anchorSec` undefined) returns `churn` itself: the wall-clock path keeps its
 * entries, identity included.
 */
export function anchorFileChurn(
  churn: Map<string, WindowedFileChurn>,
  anchorSec: number | undefined,
): Map<string, WindowedFileChurn> {
  if (anchorSec === undefined) return churn;
  const anchored = new Map<string, WindowedFileChurn>();
  for (const [path, entry] of churn) anchored.set(path, { ...entry, historyAnchorSec: anchorSec });
  return anchored;
}

/**
 * Fold a newest → oldest path log into per-HEAD-path age stamps. A file that
 * does not survive to HEAD stays keyed under the last name it had, as the churn
 * aggregate keys it; callers look up HEAD paths only. Among commits sharing the
 * newest author second, the one first in log order names `lastCommitHash`.
 */
export function foldFileLifetimeStamps(entries: readonly CommitPathChanges[]): Map<string, FileLifetimeStamps> {
  const stamps = new Map<string, FileLifetimeStamps>();
  foldIntoFileLifetimeStamps(stamps, entries);
  return stamps;
}

/**
 * Fold log entries INTO an existing stamps map — the incremental arm of
 * `readFileLifetimeStampsCached`. Order-independent (min/max per timestamp), so
 * folding a `tip..HEAD` range after a cached whole-history fold yields exactly
 * the fresh full-history fold: a new commit can only raise `lastModifiedAt` and
 * never lowers `firstCreatedAt` (commits older than the cached tip arrive only
 * through a rewritten history, which fails the range read and falls back cold).
 */
export function foldIntoFileLifetimeStamps(
  stamps: Map<string, FileLifetimeStamps>,
  entries: readonly CommitPathChanges[],
): Map<string, FileLifetimeStamps> {
  const attributed = resolveHeadPaths(entries);
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

/** How a `readFileLifetimeStampsCached` call was served — feeds LIFETIME_READ logging. */
export interface FileLifetimeReadInfo {
  mode: "cold" | "incremental" | "cached";
  entries: number;
  durationMs: number;
}

/**
 * Whole-history age stamps through the persistent `GitFileLifetimeStore`
 * (bd tea-rags-mcp-61gt2): a same-HEAD rerun reads no git, a moved HEAD tops
 * the cache up with `tip..HEAD`, and only a missing/invalid cache (or a range
 * the repo no longer knows — rewritten history) re-walks the whole history.
 * `store` absent degrades to the plain whole-history read.
 */
export async function readFileLifetimeStampsCached(
  adapter: VcsGitAdapter,
  root: string,
  timeoutMs: number,
  store?: GitFileLifetimeStore,
  onRead?: (info: FileLifetimeReadInfo) => void,
): Promise<Map<string, FileLifetimeStamps>> {
  const started = Date.now();
  const report = (mode: FileLifetimeReadInfo["mode"], entries: number): void => {
    onRead?.({ mode, entries, durationMs: Date.now() - started });
  };

  if (store) {
    const head = await adapter.getHead().catch(() => "");
    const cached = head ? store.load(root) : null;
    if (cached && head && cached.tip === head) {
      report("cached", cached.stamps.size);
      return cached.stamps;
    }
    if (cached && head && cached.tip !== "") {
      try {
        const fresh = await adapter.readCommitPathChanges(timeoutMs, { fromSha: cached.tip, toSha: head });
        const stamps = foldIntoFileLifetimeStamps(cached.stamps, fresh);
        store.save(root, head, stamps);
        report("incremental", stamps.size);
        return stamps;
      } catch {
        // Unknown tip (rewritten history) or a failed range read — fall back
        // to the whole-history walk below.
      }
    }
  }

  const stamps = foldFileLifetimeStamps(await adapter.readCommitPathChanges(timeoutMs));
  if (store) {
    const head = await adapter.getHead().catch(() => "");
    if (head) store.save(root, head, stamps);
  }
  report("cold", stamps.size);
  return stamps;
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
