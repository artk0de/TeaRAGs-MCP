/**
 * Index holes — files the sync snapshot lists as indexed that hold no points
 * and are neither a deliberate (deterministic) skip nor quarantined. A hole is
 * a lost file: its content is unchanged, so change detection alone never
 * re-ingests it (bd tea-rags-mcp-muj77, GitHub #10).
 *
 * Two levels, one definition. `countIndexHoles` is the count-level verdict —
 * snapshot file count against the distinct-path count the post-run stats
 * scroll persisted — cheap enough for every status read and every incremental
 * run. `selectIndexHolePaths` is the path-level answer the repair needs, fed by
 * a scroll the caller runs only when the count says holes exist. Both subtract
 * the same two sets, so status and repair cannot disagree about what a hole is.
 */

import { StatsCache } from "../../../adapters/filesystem/stats-cache.js";
import { SkippedFileStore } from "./skipped-file-store.js";
import { ShardedSnapshotManager } from "./snapshot/index.js";

/**
 * The distinct-file count of the points, as the post-run stats scroll persisted
 * it (`Distributions.totalFiles`). Undefined when no stats are cached.
 */
export function readPointFileCount(snapshotDir: string, collectionName: string): number | undefined {
  const totalFiles = new StatsCache(snapshotDir).load(collectionName)?.distributions.totalFiles;
  return typeof totalFiles === "number" && totalFiles > 0 ? totalFiles : undefined;
}

/**
 * How many snapshot files hold no points, or undefined when there is no
 * verdict: no snapshot, or stats written before it — the persisted count then
 * describes another generation of the index. Count-level by design: an orphan
 * point path outside the snapshot masks one hole.
 */
export async function countIndexHoles(
  snapshotDir: string,
  collectionName: string,
  counts: { pointFileCount: number; quarantinedCount: number },
): Promise<number | undefined> {
  const snapshot = await new ShardedSnapshotManager(snapshotDir, collectionName).readSummary();
  const statsWrittenAt = new StatsCache(snapshotDir).lastWrittenAt(collectionName);
  if (!snapshot || statsWrittenAt === undefined || statsWrittenAt < snapshot.timestamp) return undefined;
  const deterministicSkips = (await new SkippedFileStore(snapshotDir, collectionName).paths()).size;
  return Math.max(0, snapshot.fileCount - counts.pointFileCount - deterministicSkips - counts.quarantinedCount);
}

/**
 * The snapshot paths that are holes, in snapshot order. A path gone from disk
 * is left to change detection, which reports it deleted.
 */
export function selectIndexHolePaths(input: {
  snapshotPaths: readonly string[];
  scannedPaths: readonly string[];
  indexedPaths: ReadonlySet<string>;
  skippedPaths: ReadonlySet<string>;
  quarantinedPaths: ReadonlySet<string>;
}): string[] {
  const scanned = new Set(input.scannedPaths);
  return input.snapshotPaths.filter(
    (path) =>
      scanned.has(path) &&
      !input.indexedPaths.has(path) &&
      !input.skippedPaths.has(path) &&
      !input.quarantinedPaths.has(path),
  );
}
