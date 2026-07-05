/**
 * Corrupt-collection self-heal for the embedded Qdrant daemon
 * (tea-rags-mcp-mh7nr).
 *
 * A killed force-reindex can leave a half-written versioned collection whose
 * WAL still references segment ranges past the truncated file. On the NEXT
 * boot, qdrant replays that WAL inside `TableOfContent::new` and PANICS — which
 * fails the load of EVERY collection, not just the corrupt one, so the whole
 * daemon never binds its HTTP port and every later call gets a bare
 * "fetch failed". The panic is invisible because the daemon is spawned
 * detached with its stderr discarded; the fix pipes stderr to a crash log so
 * this module can read WHICH collection to move aside, then respawn clean.
 *
 * The 55xk2 orphan-versioned sweep cannot cover this: it runs INSIDE a reindex,
 * but here the daemon cannot boot to run one — a chicken-and-egg the sweep
 * structurally can't break.
 */

import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/** Basename of the crash log the daemon pipes qdrant stderr into (per storage). */
export const QDRANT_CRASH_LOG_NAME = "qdrant-crash.log";

/**
 * Read the corrupt collection's name out of a captured qdrant crash log, or
 * null when the log is not a shard-load panic (healthy boot, port clash,
 * transient connection error — anything we must NOT quarantine on).
 *
 * qdrant names the failing shard by absolute path in its panic line; the
 * collection is the path segment right after `collections/`. Matching keys on
 * the specific `Failed to load local shard "…"` panic so a generic error never
 * triggers a quarantine.
 */
export function parseCorruptCollection(crashLog: string): string | null {
  const panic = /Failed to load local shard "([^"]+)"/.exec(crashLog);
  if (!panic) return null;
  const shardPath = panic[1];
  const segment = /[/\\]collections[/\\]([^/\\]+)/.exec(shardPath);
  return segment ? segment[1] : null;
}

/**
 * Move a corrupt collection out of the daemon's `collections/` dir into
 * `.corrupt/<name>-<timestamp>` so the next boot skips it. A MOVE, never a
 * delete — the data is preserved for forensics and is reversible. Throws when
 * the collection dir is absent (nothing to recover — caller treats the daemon
 * death as non-recoverable and surfaces the original error).
 */
export function quarantineCorruptCollection(storagePath: string, collectionName: string, now: number): string {
  const source = join(storagePath, "collections", collectionName);
  const quarantineDir = join(storagePath, ".corrupt");
  mkdirSync(quarantineDir, { recursive: true });
  const dest = join(quarantineDir, `${collectionName}-${String(now)}`);
  renameSync(source, dest); // throws if source is missing → non-recoverable
  return dest;
}
