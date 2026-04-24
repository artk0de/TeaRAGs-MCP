import type { DeletionOutcome } from "./deletion-outcome.js";

/**
 * Coordinates per-file reindex decisions after a deletion pass.
 *
 * When `performDeletion` reports paths whose old chunks could not be
 * removed (L2 individual-delete failures), this coordinator blocks the
 * subsequent upsert for those files so the parallel modified-file pipeline
 * does not create orphan duplicates (old chunks still in Qdrant + new
 * chunks added = double-population — the 2026-04-23 incident).
 *
 * Usage flow (Phase 3.2): reindex orchestrator calls `applyDeletionOutcome`
 * after `deletePromise` resolves; file-processor calls `canUpsertForFile`
 * per file before invoking `chunkPipeline.addChunk`.
 */
export class ReindexCoordinator {
  private readonly blockedPaths = new Set<string>();
  private readonly skipped: string[] = [];

  applyDeletionOutcome(outcome: DeletionOutcome): void {
    for (const failed of outcome.failed) this.blockedPaths.add(failed);
  }

  canUpsertForFile(relativePath: string): boolean {
    if (this.blockedPaths.has(relativePath)) {
      this.skipped.push(relativePath);
      return false;
    }
    return true;
  }

  skippedFiles(): readonly string[] {
    return [...this.skipped];
  }

  hasBlockedPaths(): boolean {
    return this.blockedPaths.size > 0;
  }
}
