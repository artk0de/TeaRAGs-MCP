/**
 * Retention for the HEAD-keyed discovery snapshots (commit matrix, file churn).
 *
 * These caches live in a namespace shared by every working tree over one object
 * database, so several HEADs legitimately coexist there: a main checkout and
 * its linked worktrees each persist the matrix for their own HEAD. The earlier
 * rule — `save` unlinks every file that is not the HEAD just written — turned
 * that sharing into mutual eviction, costing each checkout the prior-HEAD
 * snapshot its next run would have topped up from (`git log old..new`) and
 * forcing a full repo-wide log instead.
 *
 * Keeping the newest few bounds the directory (these files run to tens of MB on
 * a monolith) while leaving each active checkout a top-up base.
 */
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Snapshots kept per repo — a main checkout plus a couple of live worktrees. */
export const RETAINED_SNAPSHOTS = 3;

/** Drop all but the newest `RETAINED_SNAPSHOTS` *.json files in `dir`. */
export function pruneSnapshots(dir: string, keep: number = RETAINED_SNAPSHOTS): void {
  const snapshots = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({ file, mtimeMs: statSync(join(dir, file)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of snapshots.slice(keep)) {
    unlinkSync(join(dir, file));
  }
}
