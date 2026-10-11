import type { DeletionOutcome } from "../../../../contracts/types/deletion.js";

export type { DeletionOutcome };

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
