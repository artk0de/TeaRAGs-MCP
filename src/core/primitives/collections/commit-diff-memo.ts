/**
 * CommitDiffMemo — run-scoped memo of per-(commitSha, filePath) diff hunks.
 *
 * bd tea-rags-mcp-7gnre: every per-batch chunk-churn walk of an indexing run
 * re-diffs the SAME sweep commits (2 blob reads + one structuredPatch per
 * (commit, file)) for files it shares with other batches. The memo lives
 * beside the run-scoped blobReader in ChunkPhase and is threaded into
 * walkCommits (via ChunkSignalOptions.diffMemo) so each (commit, file) pair is
 * diffed at most once per run.
 *
 * Lives in `primitives` on purpose: TWO domains construct it — the ingest chunk
 * phase (`enrichment/chunk-phase.ts`) and the git churn-walk worker
 * (`trajectory/git/infra/churn-walk/worker.ts`). Moving it into either one would
 * create a `domains <-> domains` edge; it is pure and I/O-free, so primitives is
 * its only legal home.
 * Consumers that merely read it depend on `CommitDiffMemoPort` in contracts.
 *
 * Memory bound: entries are LRU-capped at {@link CommitDiffMemo.DEFAULT_MAX_ENTRIES}
 * (50 000). One entry = one hunk array — 4 small integers per hunk, typically
 * 1–3 hunks — so the worst case is on the order of tens of MB and typical runs
 * stay well below 10 MB. The memo is dropped at ChunkPhase.drain() together
 * with the blobReader, so nothing outlives the run.
 */

import type { CommitDiffHunk, CommitDiffMemoPort } from "../../contracts/types/commit-diff-memo.js";

export type { CommitDiffHunk };

export class CommitDiffMemo implements CommitDiffMemoPort {
  static readonly DEFAULT_MAX_ENTRIES = 50_000;

  /** Insertion-ordered Map — re-insertion on get() makes eviction LRU. */
  private readonly entries = new Map<string, CommitDiffHunk[]>();

  constructor(private readonly maxEntries: number = CommitDiffMemo.DEFAULT_MAX_ENTRIES) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Memoized hunks for (commitSha, filePath), or undefined on a miss. An empty
   * array is a VALID memoized value (root commit / identical blobs / patch
   * failure) — callers must distinguish `[]` (known-empty) from `undefined`
   * (never computed). A hit refreshes the entry's recency.
   */
  get(commitSha: string, filePath: string): CommitDiffHunk[] | undefined {
    const key = `${commitSha}\0${filePath}`;
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit;
  }

  set(commitSha: string, filePath: string, hunks: CommitDiffHunk[]): void {
    const key = `${commitSha}\0${filePath}`;
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const lru = this.entries.keys().next().value;
      if (lru !== undefined) this.entries.delete(lru);
    }
    this.entries.set(key, hunks);
  }
}
