/**
 * Registry domain DTOs — the answer shapes of registry maintenance.
 */

/**
 * A registry entry whose project directory is gone from disk.
 *
 * Deliberately narrower than `CollectionEntry`: a sweep reports WHICH entry
 * lost its directory and how much index sits behind it, not the embedding
 * endpoints or the env snapshot of the run that produced it.
 */
export interface StaleProjectEntry {
  collectionName: string;
  /** Alias the entry holds, or null when it never got one. */
  name: string | null;
  path: string;
  chunksCount: number;
  indexedAt: string;
  /** Source collection when the entry is a worktree clone. */
  worktreeOf?: string;
}

/** What a stale-entry sweep removed and what it deliberately left behind. */
export interface StaleProjectPruneReport {
  removed: StaleProjectEntry[];
  /**
   * Stale entries still in the registry: the NAMED ones (their alias re-points
   * on the next `register`) plus anything the caller blocked.
   */
  kept: StaleProjectEntry[];
}
