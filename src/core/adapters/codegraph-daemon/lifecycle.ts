import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DaemonLock } from "../qdrant/embedded/daemon-lock.js";

const daemonLock = new DaemonLock();

const IDLE_SHUTDOWN_MS = 30_000;
const IDLE_POLL_INTERVAL_MS = 5_000;

export { IDLE_SHUTDOWN_MS };

export interface CodegraphDaemonPaths {
  storageDir: string;
  socketPath: string;
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
}

/* v8 ignore next 3 -- fallback for backward compat when DI app-data path not provided */
function fallbackAppDataDir(): string {
  return join(homedir(), ".tea-rags");
}

/**
 * Resolve the on-disk directory that holds the codegraph daemon's lifecycle
 * files (socket, pid, port, refs, lock). Honors TEA_RAGS_CODEGRAPH_DAEMON_DIR
 * for test/CI overrides; otherwise nests `codegraph/` under the app-data dir.
 */
export function getStorageDir(appDataPath?: string): string {
  return (
    process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR ?? join(appDataPath ?? fallbackAppDataDir(), "codegraph")
  );
}

export function getDaemonPaths(storageDir: string): CodegraphDaemonPaths {
  return {
    storageDir,
    socketPath: join(storageDir, "codegraph-daemon.sock"),
    pidFile: join(storageDir, "codegraph-daemon.pid"),
    portFile: join(storageDir, "codegraph-daemon.port"),
    refsFile: join(storageDir, "codegraph-daemon.refs"),
    lockFile: join(storageDir, "codegraph-daemon.lock"),
  };
}

export function readRefs(paths: CodegraphDaemonPaths): number {
  try {
    return parseInt(readFileSync(paths.refsFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export function incrementRefs(paths: CodegraphDaemonPaths): number {
  mkdirSync(dirname(paths.refsFile), { recursive: true });
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = readRefs(paths) + 1;
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}

export function decrementRefs(paths: CodegraphDaemonPaths): number {
  mkdirSync(dirname(paths.refsFile), { recursive: true });
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = Math.max(0, readRefs(paths) - 1);
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}

/**
 * Poll the refs file every 5s; once it has stayed at <= 0 for IDLE_SHUTDOWN_MS,
 * clear the interval and invoke onShutdown so the daemon releases the RW DuckDB
 * lock. The interval is `.unref()`'d so it never keeps the process alive on its
 * own. Mirrors the Qdrant embedded daemon idle watcher.
 */
export function scheduleIdleWatcher(
  paths: CodegraphDaemonPaths,
  onShutdown: () => void,
): NodeJS.Timeout {
  let idleSince: number | null = null;

  const interval = setInterval(() => {
    if (readRefs(paths) <= 0) {
      if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
        clearInterval(interval);
        onShutdown();
      }
    } else {
      idleSince = null;
    }
  }, IDLE_POLL_INTERVAL_MS);

  interval.unref();
  return interval;
}
