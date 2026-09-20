/**
 * Build-keyed codegraph daemon restart — the orchestration behind
 * `tea-rags doctor --restart` (bd tea-rags-mcp-42hno).
 *
 * Build keying makes two or more live daemons on one machine the NORMAL case
 * (one per build: a worktree build next to a global install, an `npm link`
 * flip), so a restart is a FAN-OUT: every live keyed daemon is stopped —
 * each session's next codegraph op then cold-spawns ITS build's daemon again,
 * which is the "restart" — and key directories of daemons that are already
 * gone are swept. The lifecycle layout itself is owned by
 * `core/adapters/duckdb/daemon/lifecycle.ts`; this module only orchestrates
 * over its listings.
 *
 * `cli/` reaches this through `src/cli/commands/doctor.ts` (cli → bootstrap is
 * the legal direction; cli never imports `core/adapters` directly).
 */

import {
  getStorageDir,
  listDaemonKeyDirs,
  sweepOrphanedDaemonKeyDirs,
  waitForDaemonExit,
} from "../core/adapters/duckdb/daemon/index.js";

/** What one build-key directory's restart pass decided. */
export interface CodegraphDaemonRestartOutcome {
  keyDir: string;
  pid?: number;
  /** stopped — signalled and gone; swept — already dead, dir removed. */
  action: "stopped" | "swept" | "exit-timeout" | "signal-failed";
}

export interface CodegraphDaemonRestartDeps {
  /** Base daemon lifecycle storage dir (the parent of the key directories). */
  storageDir: string;
  /**
   * Stop the daemon process. Defaults to SIGTERM — the daemon's own handler
   * drains gracefully (bounded ~3s teardown), unlinks its lifecycle files and
   * exits; the exit wait below observes exactly that.
   */
  signal?: (pid: number) => void;
  /** Upper bound on one daemon's exit wait (default 10s, as the pool uses). */
  exitTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** The base storage dir `restartCodegraphDaemons` should be pointed at. */
export function codegraphDaemonStorageDir(appDataPath: string): string {
  return getStorageDir(appDataPath);
}

/**
 * Stop every live keyed daemon under `storageDir`, then sweep the orphaned
 * key directories. A daemon that did not exit within the window is left
 * ALONE — it is wedged but alive, and its directory (and DuckDB handles with
 * it) belong to a live process; the report names it for manual inspection.
 */
export async function restartCodegraphDaemons(
  deps: CodegraphDaemonRestartDeps,
): Promise<CodegraphDaemonRestartOutcome[]> {
  const signal = deps.signal ?? defaultSignal;
  const outcomes: CodegraphDaemonRestartOutcome[] = [];
  for (const status of listDaemonKeyDirs(deps.storageDir)) {
    if (!status.alive || status.pid === undefined) continue;
    try {
      signal(status.pid);
    } catch {
      outcomes.push({ keyDir: status.keyDir, pid: status.pid, action: "signal-failed" });
      continue;
    }
    const exited = await waitForDaemonExit(status.paths, status.pid, {
      timeoutMs: deps.exitTimeoutMs,
      pollIntervalMs: deps.pollIntervalMs,
    });
    outcomes.push({ keyDir: status.keyDir, pid: status.pid, action: exited ? "stopped" : "exit-timeout" });
  }
  for (const keyDir of sweepOrphanedDaemonKeyDirs(deps.storageDir)) {
    outcomes.push({ keyDir, action: "swept" });
  }
  return outcomes;
}

function defaultSignal(pid: number): void {
  process.kill(pid, "SIGTERM");
}
