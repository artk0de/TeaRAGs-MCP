/**
 * Detached auto-update updater lifecycle (hpg2, spec §4).
 *
 * Runs inside the ephemeral `tea-rags auto-update run` process. The sequence
 * is deliberately re-entrant and race-tolerant:
 *
 *  1. registry re-read      — the project may have been unregistered
 *  2. freshness RE-check    — TOCTOU guard: branch may have moved since spawn
 *  3. lock probe            — a live indexing-marker heartbeat means another
 *                             run owns the collection → exit lock-held
 *  4. incremental reindex   — `App.indexCodebase` (Merkle delta detector)
 *  5. enrichment wait       — the process is detached, nobody waits on IT, so
 *                             waiting is free and leaves the index consistent
 *  6. lastRun write         — on EVERY path (ok/no-op/skipped/lock-held/failed)
 *                             except a vanished entry, where no block exists
 *
 * The exit code is consumed by `auto-update status` and the log file only —
 * the spawner never waits.
 */

import type { App, AutoUpdateRunRecord, CollectionRegistry, IndexFreshnessCheck } from "../../core/api/public/index.js";

export const AUTO_UPDATE_EXIT = { ok: 0, failed: 1, skipped: 2, lockHeld: 3 } as const;

const ERROR_TRIM_LENGTH = 500;

export interface RunUpdaterDeps {
  app: Pick<App, "indexCodebase" | "getIndexStatus" | "whenEnrichmentComplete">;
  registry: Pick<CollectionRegistry, "get" | "recordAutoUpdateRun">;
  freshness: Pick<IndexFreshnessCheck, "check">;
  clock: () => number;
  log: (line: string) => void;
}

/**
 * Full updater lifecycle. Returns the exit code — the CLI entry process.exit()s
 * with it. Never throws: every failure funnels into `outcome: "failed"`.
 */
export async function runUpdater(collectionName: string, deps: RunUpdaterDeps): Promise<number> {
  const startedAt = deps.clock();
  const record = (outcome: AutoUpdateRunRecord["outcome"], filesChanged: number, error?: string): void => {
    deps.registry.recordAutoUpdateRun(collectionName, {
      at: new Date(deps.clock()).toISOString(),
      outcome,
      durationMs: deps.clock() - startedAt,
      filesChanged,
      ...(error !== undefined ? { error: error.slice(0, ERROR_TRIM_LENGTH) } : {}),
    });
  };

  const entry = deps.registry.get(collectionName);
  if (entry === null) {
    deps.log(`[auto-update] ${collectionName}: registry entry vanished — skipped`);
    return AUTO_UPDATE_EXIT.skipped;
  }

  const verdict = deps.freshness.check(entry);
  if (verdict.kind !== "eligible") {
    deps.log(`[auto-update] ${collectionName}: verdict ${verdict.kind} at run time — skipped`);
    record("skipped", 0);
    return AUTO_UPDATE_EXIT.skipped;
  }

  try {
    const status = await deps.app.getIndexStatus(entry.path);
    if (status.status === "indexing") {
      deps.log(`[auto-update] ${collectionName}: another indexing run holds the marker — lock-held`);
      record("lock-held", 0);
      return AUTO_UPDATE_EXIT.lockHeld;
    }

    deps.log(`[auto-update] ${collectionName}: reindexing ${entry.path}`);
    const stats = await deps.app.indexCodebase(entry.path);
    const filesChanged = countFilesChanged(stats);
    await deps.app.whenEnrichmentComplete();

    const outcome = filesChanged === 0 ? "no-op" : "ok";
    deps.log(`[auto-update] ${collectionName}: ${outcome} — ${filesChanged} files in ${deps.clock() - startedAt}ms`);
    record(outcome, filesChanged);
    return AUTO_UPDATE_EXIT.ok;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`[auto-update] ${collectionName}: failed — ${message}`);
    record("failed", 0, message);
    return AUTO_UPDATE_EXIT.failed;
  }
}

/** Prefer the reindex delta when present; a fresh full index counts filesIndexed. */
function countFilesChanged(stats: {
  filesIndexed: number;
  changeDetails?: { filesAdded: number; filesModified: number; filesDeleted: number };
}): number {
  const delta = stats.changeDetails;
  if (delta !== undefined) return delta.filesAdded + delta.filesModified + delta.filesDeleted;
  return stats.filesIndexed;
}
