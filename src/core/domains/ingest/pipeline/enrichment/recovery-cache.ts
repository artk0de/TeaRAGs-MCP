/**
 * RecoveryStateCache — local file marker for recovery completion.
 *
 * Avoids expensive Qdrant scrolls on every incremental reindex.
 * File exists = recovery complete, skip entirely (0ms).
 * File missing = recovery needed, run in background.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function markerPath(snapshotDir: string, collectionName: string): string {
  return join(snapshotDir, `${collectionName}.recovery-complete`);
}

/** Check if recovery has been completed for this collection. Instant (disk). */
export function isRecoveryComplete(snapshotDir: string, collectionName: string): boolean {
  return existsSync(markerPath(snapshotDir, collectionName));
}

/** Mark recovery as complete. Called after successful background recovery. */
export function markRecoveryComplete(snapshotDir: string, collectionName: string): void {
  const dir = snapshotDir;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(markerPath(snapshotDir, collectionName), new Date().toISOString(), "utf-8");
}

/** Invalidate recovery cache. Called when new chunks are added (reindex with adds/modifies). */
export function invalidateRecoveryCache(snapshotDir: string, collectionName: string): void {
  const path = markerPath(snapshotDir, collectionName);
  try {
    if (existsSync(path)) {
      unlinkSync(path);
    }
  } catch {
    // Ignore — file may already be deleted
  }
}
