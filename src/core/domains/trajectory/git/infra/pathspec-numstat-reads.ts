/**
 * One on-demand computation's pathspec numstat reads
 * (`VcsGitAdapter#readCommitFileNumstatForPaths`), kept for the length of the
 * call so the chunk walk's window is SLICED out of the file walk's read
 * instead of being read again (bd tea-rags-mcp-89k7k.35.22): every read is a
 * git process, and process creation — not git's own work — is what an
 * on-demand computation costs.
 *
 * Only a WINDOWED read is served from: `since` present makes the adapter walk
 * `--since --full-history`, the walk the chunk-window discovery runs; the
 * unwindowed read is a default-simplified whole-history log, a different
 * commit set. A slice of a read whose path set covers the request and whose
 * window contains it keeps what a read of the request itself returns: the
 * commits whose committer time is at or after `since` (git's `--since`
 * comparison, whole seconds), each with its rows on a requested path — either
 * side of a rename — and a commit left with none dropped, as the pathspec
 * would never list it. A merge carries no numstat rows in either read and is
 * kept when inside the window.
 *
 * Two divergences remain, both toward ingest's repo-wide commit matrix, never
 * away from it: committer-clock skew (git's limited walk marks the parents of
 * a too-old commit uninteresting, a client-side filter does not), and a merge
 * listed only for an unrequested path whose branch also touched a requested
 * one without changing it at the merge.
 *
 * Per-call state only — an index run's discovery matrix is never consulted or
 * perturbed (the module contract of `on-demand-signals.ts`).
 */

import type { CommitFileNumstat, VcsGitAdapter } from "../../../../adapters/vcs/index.js";

export interface PathspecNumstatReads {
  /** `readCommitFileNumstatForPaths`, memoised for this call. */
  read: (paths: string[], timeoutMs: number, since?: Date) => Promise<CommitFileNumstat[]>;
  /**
   * The entries of a completed windowed read whose path set covers `paths`
   * and whose window starts at or before `since`, restricted to `paths` and
   * to commits at or after `since`; `undefined` when no read qualifies.
   */
  sliceFor: (paths: string[], since: Date) => CommitFileNumstat[] | undefined;
}

interface CompletedWindowedRead {
  paths: ReadonlySet<string>;
  sinceSec: number;
  entries: CommitFileNumstat[];
}

/** git compares `--since` in whole seconds against the committer time. */
const sinceSecOf = (since: Date): number => Math.floor(since.getTime() / 1000);

export function createPathspecNumstatReads(
  adapter: Pick<VcsGitAdapter, "readCommitFileNumstatForPaths">,
): PathspecNumstatReads {
  const inFlight = new Map<string, Promise<CommitFileNumstat[]>>();
  const completed: CompletedWindowedRead[] = [];

  const read = async (paths: string[], timeoutMs: number, since?: Date): Promise<CommitFileNumstat[]> => {
    const key = `${since?.toISOString() ?? ""}\0${[...paths].sort().join("\0")}`;
    const memoised = inFlight.get(key);
    if (memoised) return memoised;
    const pending = adapter.readCommitFileNumstatForPaths(paths, timeoutMs, since);
    inFlight.set(key, pending);
    try {
      const entries = await pending;
      if (since) completed.push({ paths: new Set(paths), sinceSec: sinceSecOf(since), entries });
      return entries;
    } catch (error) {
      inFlight.delete(key);
      throw error;
    }
  };

  const sliceFor = (paths: string[], since: Date): CommitFileNumstat[] | undefined => {
    const sinceSec = sinceSecOf(since);
    const covering = completed.find(
      (candidate) => candidate.sinceSec <= sinceSec && paths.every((path) => candidate.paths.has(path)),
    );
    if (!covering) return undefined;
    const named = new Set(paths);
    const sliced: CommitFileNumstat[] = [];
    for (const entry of covering.entries) {
      if (entry.committerTimestamp < sinceSec) continue;
      if (entry.files.length === 0) {
        sliced.push(entry);
        continue;
      }
      const files = entry.files.filter(
        (row) => named.has(row.path) || (row.previousPath !== undefined && named.has(row.previousPath)),
      );
      if (files.length === 0) continue;
      sliced.push(files.length === entry.files.length ? entry : { ...entry, files });
    }
    return sliced;
  };

  return { read, sliceFor };
}
