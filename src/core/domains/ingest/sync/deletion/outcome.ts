/**
 * Tracks the per-path outcome of a deletion pass.
 *
 * Callers populate `failed` via markFailed or markAllFailed when the
 * underlying Qdrant operation reports (or behaves as) a partial or total
 * failure. Consumers (e.g. ReindexCoordinator in Phase 3) use `failed`
 * to decide which files must be excluded from subsequent upsert.
 */
export interface DeletionOutcome {
  readonly succeeded: Set<string>;
  readonly failed: Set<string>;
  chunksDeleted: number;
  markFailed: (path: string) => void;
  markAllFailed: () => void;
  isFullSuccess: () => boolean;
}

export function createDeletionOutcome(attemptedPaths: string[]): DeletionOutcome {
  const succeeded = new Set(attemptedPaths);
  const failed = new Set<string>();
  return {
    succeeded,
    failed,
    chunksDeleted: 0,
    markFailed(path) {
      if (succeeded.delete(path)) failed.add(path);
    },
    markAllFailed() {
      for (const p of succeeded) failed.add(p);
      succeeded.clear();
    },
    isFullSuccess() {
      return failed.size === 0;
    },
  };
}
