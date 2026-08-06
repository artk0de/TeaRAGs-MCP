/**
 * Detached auto-update spawner (hpg2, spec §4).
 *
 * Launches `tea-rags auto-update run --project <X>` as an ephemeral process
 * that survives the parent: `detached: true` puts it in its own process
 * group (reparented to init/launchd on parent exit), `unref()` lets the
 * parent exit freely. stdout/stderr both point at the per-project log fd.
 *
 * Lives in bootstrap on purpose: both consumers — the prime CLI (SessionStart)
 * and the MCP tool trigger (via registration deps) — are composed here;
 * cli may import bootstrap, bootstrap hands the trigger into mcp, and neither
 * needs a path into the other.
 *
 * Spawns are intentionally cheap and "dumb": races between sessions are
 * resolved by the indexing marker inside the updater, not by coordinating
 * spawners. A spawn failure is swallowed — the trigger path must never break
 * a serving query.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface SpawnDetachedUpdaterOptions {
  /** Registry alias or collectionName — passed through to the subcommand. */
  project: string;
  /** Open fd of the per-project auto-update log (see cli/auto-update/updater-log). */
  logFd: number;
  spawnImpl?: typeof nodeSpawn;
  /** Test override; default resolves build/cli/index.js from this install. */
  cliEntryPath?: string;
}

/**
 * Resolve this package's own CLI entry via import.meta.url — no PATH
 * dependency, and the updater always runs the SAME installed build as the
 * process that spawned it. This file lives at
 * `{src|build}/bootstrap/auto-update/spawner.{ts|js}`, two levels below the
 * package layout root — `../../cli/index.js` in both trees.
 */
function resolveOwnCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "cli", "index.js");
}

export function spawnDetachedUpdater(opts: SpawnDetachedUpdaterOptions): void {
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const cliEntry = opts.cliEntryPath ?? resolveOwnCliEntry();
  try {
    const child = spawnImpl(process.execPath, [cliEntry, "auto-update", "run", "--project", opts.project], {
      detached: true,
      stdio: ["ignore", opts.logFd, opts.logFd],
    });
    child.unref();
  } catch {
    // Fire-and-forget: a failed spawn must never surface into the serving
    // query or prime. The next trigger check will simply try again.
  }
}
