/**
 * The query clock of an index (bd tea-rags-mcp-zwu7m).
 *
 * `TRAJECTORY_GIT_ANCHOR=head` measures every window and every stored age of an
 * index run from the HEAD commit's committer time (bd tea-rags-mcp-i6tkc). A
 * read of that index must measure from the same instant, or a payload written
 * against HEAD is compared with today — a years-old benchmark snapshot reads
 * every file as dormant. The mode is the one the index was STAMPED with (its
 * registry env snapshot), the instant is its `indexedCommit`'s committer time;
 * everything else reads the wall clock (`undefined`, the convention the
 * index-time anchor already uses).
 *
 * Joins the registry (maintenance) with git (adapters) and the mode rule
 * (trajectory), which is why it lives in the composition layer. Resolved ONCE
 * per request by the read path (`ExploreOps`, `TracePathOps`) and threaded to
 * every age read from there.
 */

import { readCommitTime as readCommitTimeAt } from "../../../adapters/vcs/git/git-cli/client.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import { resolveIndexHistoryAnchorSec, stampedHistoryAnchorMode } from "../../../domains/trajectory/git/index.js";

export interface IndexHistoryAnchorResolverDeps {
  collectionRegistry: { get: (collectionName: string) => CollectionEntry | null };
  /** A commit's committer time in unix seconds, read in `repoPath`. Default: the git CLI. */
  readCommitTime?: (repoPath: string, commit: string) => Promise<number>;
}

export class IndexHistoryAnchorResolver {
  private readonly readCommitTime: (repoPath: string, commit: string) => Promise<number>;
  /**
   * Successful reads, keyed (collection, indexedCommit): a reindex moves the
   * commit and so the key. A failed read is not cached — the wall-clock answer
   * it falls back to is cheap to recompute and must not outlive a transient
   * git failure.
   */
  private readonly anchors = new Map<string, Promise<number>>();

  constructor(private readonly deps: IndexHistoryAnchorResolverDeps) {
    this.readCommitTime = deps.readCommitTime ?? (async (repoPath, commit) => readCommitTimeAt(repoPath, commit));
  }

  /** The index's query anchor in unix SECONDS, or `undefined` for the wall clock. Never rejects. */
  async anchorSecOf(collectionName: string): Promise<number | undefined> {
    const entry = this.deps.collectionRegistry.get(collectionName);
    if (!entry) return undefined;
    const indexedCommit = entry.git?.indexedCommit;
    return resolveIndexHistoryAnchorSec(stampedHistoryAnchorMode(entry.env), indexedCommit, async (commit) =>
      this.cachedCommitTime(collectionName, entry.path, commit),
    );
  }

  private async cachedCommitTime(collectionName: string, repoPath: string, commit: string): Promise<number> {
    const key = `${collectionName}\u0000${commit}`;
    const cached = this.anchors.get(key);
    if (cached) return cached;
    const read = this.readCommitTime(repoPath, commit);
    this.anchors.set(key, read);
    read.catch(() => this.anchors.delete(key));
    return read;
  }
}
