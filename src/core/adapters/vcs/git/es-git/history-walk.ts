/**
 * Commit-graph walks + output aggregation for EsGitAdapter history ops.
 *
 * Two walk flavors mirror the git CLI exactly:
 *
 * - plain walk (`git log [from..to] [--since]`, NO pathspec): libgit2 revwalk
 *   in default git-like order. Merge commits emit NO numstat rows — matching
 *   `git log --numstat` without `-m` (empirically pinned) — so they are
 *   skipped without ever being diffed. `--since` compares COMMITTER dates.
 *
 * - pathspec walk (`git log [--since] -- <paths>`): a manual walk implementing
 *   git's DEFAULT history simplification — a merge TREESAME to some parent
 *   follows ONLY the first such parent (side branches whose changes were
 *   discarded stay invisible); non-TREESAME merges walk all parents but still
 *   emit no rows. Pop order is committer-date descending (git's commit queue).
 *
 * es-git 0.7 exposes no parent accessor on `Commit`, so parent oids (`%P`)
 * are recovered by probing `revparseSingle("<sha>^<n>")` until it throws.
 *
 * Aggregations mirror the CLI parsers byte-for-byte: `aggregateFileChurn` ↔
 * `parseNumstatOutput`, `aggregateCommitsWithChangedFiles` ↔
 * `parsePathspecOutput` — one shared CommitInfo per commit, binary rows
 * excluded everywhere, row-less commits dropped.
 */

import { RevwalkSort, type Repository } from "es-git";

import type { CommitInfo, CommitWithChangedFiles, FileChurnData } from "../../types.js";
import {
  buildTreeDiff,
  collectCommitNumstatRows,
  hasAnyDelta,
  type EsGitNumstatRow,
  type RenameDetectionMode,
} from "./diff-numstat.js";

/** One shown log commit with its numstat rows (pre-aggregation). */
export interface EsGitLogEntry {
  commit: CommitInfo;
  rows: EsGitNumstatRow[];
}

/** Parent oids in `%P` order — `revparseSingle("<sha>^<n>")` probing. */
export function resolveParentOids(repo: Repository, sha: string): string[] {
  const parents: string[] = [];
  for (let n = 1; ; n++) {
    try {
      parents.push(repo.revparseSingle(`${sha}^${n}`));
    } catch {
      return parents;
    }
  }
}

interface CommitInfoWithCommitterTs {
  info: CommitInfo;
  committerTs: number;
}

function toCommitInfo(repo: Repository, sha: string, parents: string[]): CommitInfoWithCommitterTs {
  const commit = repo.getCommit(sha);
  const author = commit.author();
  return {
    info: {
      sha,
      author: author.name,
      authorEmail: author.email,
      timestamp: author.timestamp, // %at — author date
      body: commit.message(), // %B — full raw message
      parents,
    },
    committerTs: commit.committer().timestamp, // --since bounds compare committer dates
  };
}

export interface PlainLogWalkOptions {
  /** Rev the log starts from (`git log <toRev>`). */
  toRev: string;
  /** Lower reachability bound (`git log <fromRev>..<toRev>`). */
  fromRev?: string;
  /** `--since` bound in unix seconds (committer date, inclusive). */
  sinceSec?: number;
}

/** `git log [from..to] [--since] --numstat` — no pathspec, no simplification. */
export function collectPlainLogEntries(
  repo: Repository,
  renameMode: RenameDetectionMode,
  options: PlainLogWalkOptions,
): EsGitLogEntry[] {
  // Unresolvable bounds reject, exactly like the CLI's `git log` would.
  const toOid = repo.revparseSingle(options.toRev);
  const fromOid = options.fromRev === undefined ? undefined : repo.revparseSingle(options.fromRev);

  const walk = repo.revwalk();
  walk.setSorting(RevwalkSort.None); // libgit2 default = git's reverse-chronological order
  walk.push(toOid);
  if (fromOid !== undefined) walk.hide(fromOid);

  const entries: EsGitLogEntry[] = [];
  for (let sha = walk.next(); sha !== null; sha = walk.next()) {
    const parents = resolveParentOids(repo, sha);
    if (parents.length > 1) continue; // merge: header-only in `git log --numstat` → parsers drop it
    const { info, committerTs } = toCommitInfo(repo, sha, parents);
    if (options.sinceSec !== undefined && committerTs < options.sinceSec) continue;
    const rows = collectCommitNumstatRows(repo, parents[0] ?? null, sha, renameMode);
    if (rows.length > 0) entries.push({ commit: info, rows });
  }
  return entries;
}

/**
 * `git log [--since] --numstat -- <paths>` — HEAD-rooted walk with git's
 * default history simplification (see module header).
 */
export function collectPathspecLogEntries(
  repo: Repository,
  renameMode: RenameDetectionMode,
  paths: string[],
  sinceSec?: number,
): EsGitLogEntry[] {
  const headOid = repo.revparseSingle("HEAD");
  const heap = new CommitterDateMaxHeap();
  const enqueued = new Set<string>();
  const enqueue = (sha: string): void => {
    if (enqueued.has(sha)) return;
    enqueued.add(sha);
    heap.push(sha, repo.getCommit(sha).committer().timestamp);
  };
  enqueue(headOid);

  const entries: EsGitLogEntry[] = [];
  for (let sha = heap.pop(); sha !== undefined; sha = heap.pop()) {
    const parents = resolveParentOids(repo, sha);

    if (parents.length > 1) {
      const treesameParent = parents.find((parent) => !hasAnyDelta(buildTreeDiff(repo, parent, sha, paths)));
      if (treesameParent !== undefined) {
        enqueue(treesameParent); // simplify: follow ONLY the first TREESAME parent
        continue;
      }
      for (const parent of parents) enqueue(parent);
      continue; // shown by git, but --numstat emits no rows for merges → dropped
    }

    if (parents.length === 1) enqueue(parents[0]);
    const rows = collectCommitNumstatRows(repo, parents[0] ?? null, sha, renameMode, paths);
    if (rows.length === 0) continue; // TREESAME under the pathspec → simplified away
    const { info, committerTs } = toCommitInfo(repo, sha, parents);
    if (sinceSec !== undefined && committerTs < sinceSec) continue;
    entries.push({ commit: info, rows });
  }
  return entries;
}

/** Mirrors `parseNumstatOutput`: per-file commit list + added/deleted totals. */
export function aggregateFileChurn(entries: EsGitLogEntry[]): Map<string, FileChurnData> {
  const fileMap = new Map<string, FileChurnData>();
  for (const { commit, rows } of entries) {
    for (const row of rows) {
      if (row.binary) continue; // CLI numstat `-\t-` rows never parse into the map
      let churn = fileMap.get(row.filePath);
      if (churn === undefined) {
        churn = { commits: [], linesAdded: 0, linesDeleted: 0 };
        fileMap.set(row.filePath, churn);
      }
      churn.commits.push(commit);
      churn.linesAdded += row.added;
      churn.linesDeleted += row.deleted;
    }
  }
  return fileMap;
}

/** Mirrors `parsePathspecOutput`: commit + changed files, row-less commits dropped. */
export function aggregateCommitsWithChangedFiles(entries: EsGitLogEntry[]): CommitWithChangedFiles[] {
  const result: CommitWithChangedFiles[] = [];
  for (const { commit, rows } of entries) {
    const changedFiles = rows.filter((row) => !row.binary).map((row) => row.filePath);
    if (changedFiles.length > 0) result.push({ commit, changedFiles });
  }
  return result;
}

/**
 * Max-heap keyed by committer timestamp (descending), FIFO on ties — the
 * pathspec walk's stand-in for git's date-ordered commit queue.
 */
class CommitterDateMaxHeap {
  private readonly nodes: { sha: string; ts: number; seq: number }[] = [];
  private seq = 0;

  push(sha: string, ts: number): void {
    this.nodes.push({ sha, ts, seq: this.seq++ });
    let child = this.nodes.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.higher(child, parent)) break;
      this.swap(child, parent);
      child = parent;
    }
  }

  pop(): string | undefined {
    const top = this.nodes[0];
    if (top === undefined) return undefined;
    const last = this.nodes.pop();
    if (this.nodes.length > 0 && last !== undefined) {
      this.nodes[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let best = parent;
        if (left < this.nodes.length && this.higher(left, best)) best = left;
        if (right < this.nodes.length && this.higher(right, best)) best = right;
        if (best === parent) break;
        this.swap(parent, best);
        parent = best;
      }
    }
    return top.sha;
  }

  private higher(a: number, b: number): boolean {
    const na = this.nodes[a];
    const nb = this.nodes[b];
    return na.ts > nb.ts || (na.ts === nb.ts && na.seq < nb.seq);
  }

  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b], this.nodes[a]];
  }
}
