/**
 * Layout + stale-file sweep for the codegraph OUTPUT spill directory
 * (`<dataDir>/codegraph/.spill/`), split out of `pool.ts` for the same reason
 * `CodegraphDbFiles` was: the rules that decide which file may be deleted must
 * be callable — and unit-testable — WITHOUT constructing a pool.
 *
 * Two kinds of file share this directory:
 *
 *   1. `<collection>-<runId>.ndjson` — pass-1's own extraction spill, written
 *      by `createCodegraphExtractionSink` and read back by pass-2's
 *      `resolveAndUpsert`. Live for the whole span between the run's first
 *      `write()` and its `finish()`.
 *   2. DuckDB's temp files — the pool points `temp_directory` here so a capped
 *      connection can spill hash joins to disk.
 *
 * Both outlive their owner when a process crashes, which is why the directory
 * is swept at all. The sweep must therefore answer one question per entry: is
 * somebody still using this? A `.live` marker holding the owner pid answers it
 * for (1); (2) has no owner we can name, so it rides along with (1) — see
 * `purgeStaleSpills`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Suffix of the sibling liveness marker for an output spill. */
const LIVE_MARKER_SUFFIX = ".live";

/** Extension of an output spill written by the codegraph extraction sink. */
const SPILL_EXTENSION = ".ndjson";

/**
 * Sibling liveness marker for `spillPath`: `<spill>.ndjson.live`, holding the
 * decimal pid of the process whose sink owns the spill.
 *
 * The sink creates it BEFORE opening the spill stream and removes it in its
 * cleanup, so "marker present with a live pid" is the only state in which a
 * spill must be left alone. Deriving the marker from the spill path rather than
 * passing it around keeps one owner of the naming — a marker that got out of
 * step with its spill would silently re-open the deletion window.
 */
export function spillLiveMarkerPath(spillPath: string): string {
  return `${spillPath}${LIVE_MARKER_SUFFIX}`;
}

/** Signal-0 liveness probe (`kill` throws ESRCH once the process is gone). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Read a marker's pid; `undefined` when it is missing or not a pid. */
function readMarkerPid(markerPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(markerPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove the spill files no process is using any more, and recreate the
 * directory so a DuckDB `SET temp_directory` has somewhere to point.
 *
 * The rule, and why it is not the blanket `rmSync` it replaces (bd
 * tea-rags-mcp-v6gxr): a pool is constructed FAR more often than once per run.
 * The pass-1 extraction fan-out dispatches `extractFileBatch` with no routing
 * key, so any unpinned enrichment worker rebuilds the codegraph provider — and
 * its pool — in-thread while the affinity worker's sink is mid-spill; the
 * codegraph daemon is spawned lazily on the first write and builds a pool of
 * its own in a separate process; and two overlapping CLI runs on different
 * collections each build one at start-up. A directory-wide purge from any of
 * those deleted the in-flight NDJSON and pass-2 then failed with `ENOENT … after
 * 0 files`, leaving a 12 KB DuckDB file behind. Restricting the purge to the
 * top-level process would still not survive the last of those three, so the
 * predicate is ownership, not provenance.
 *
 * Sibling `.xpass` (the cross-pass INPUT spill) is not swept at all — see
 * `GraphDbClientPool#inputSpillPathFor` for why it cannot be.
 *
 * @param spillDir Absolute path of the `.spill` directory.
 * @param isAlive Liveness probe; injectable so a test can pin a dead pid.
 */
export function purgeStaleSpills(spillDir: string, isAlive: (pid: number) => boolean = isPidAlive): void {
  try {
    const entries = existsSync(spillDir) ? readdirSync(spillDir) : [];
    const doomed: string[] = [];
    let liveOwnerSeen = false;

    for (const entry of entries) {
      if (entry.endsWith(LIVE_MARKER_SUFFIX)) {
        // A marker whose owner is gone claims nothing. Its spill (if the run
        // got that far) is condemned by the branch below on its own name; the
        // marker has to go by this one, because a run that died between writing
        // the marker and opening the stream leaves no spill to carry it out.
        const pid = readMarkerPid(join(spillDir, entry));
        if (pid === undefined || !isAlive(pid)) doomed.push(join(spillDir, entry));
        continue;
      }
      if (!entry.endsWith(SPILL_EXTENSION)) continue; // DuckDB temp — second pass
      const spillPath = join(spillDir, entry);
      const markerPath = spillLiveMarkerPath(spillPath);
      const pid = readMarkerPid(markerPath);
      if (pid !== undefined && isAlive(pid)) {
        liveOwnerSeen = true;
        continue;
      }
      doomed.push(spillPath, markerPath);
    }

    // DuckDB's temp files carry no owner, so the only signal available is
    // whether ANY run is live in this directory. Sweeping them while one is
    // would risk yanking a spilled hash join out from under it; keeping them
    // while none is would leak disk. This narrows the window rather than
    // closing it — a process holding only a DuckDB connection, with no spill of
    // its own, is still invisible here.
    if (!liveOwnerSeen) {
      for (const entry of entries) {
        if (!entry.endsWith(SPILL_EXTENSION) && !entry.endsWith(LIVE_MARKER_SUFFIX)) {
          doomed.push(join(spillDir, entry));
        }
      }
    }

    for (const path of doomed) rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort: a permission error here is not worth aborting pool
    // construction over. DuckDB's temp_directory setting also tolerates the
    // directory being missing — the driver creates it lazily.
  }
  mkdirSync(spillDir, { recursive: true });
}
