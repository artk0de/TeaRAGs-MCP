import { mkdirSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DaemonLock } from "../../qdrant/embedded/daemon-lock.js";

const daemonLock = new DaemonLock();

const IDLE_SHUTDOWN_MS = 30_000;
const IDLE_POLL_INTERVAL_MS = 5_000;

export { IDLE_SHUTDOWN_MS };

/**
 * Size at which the daemon log is started over on the next spawn. The daemon
 * writes only startup and failure output, so this holds many spawns' worth of
 * history while keeping an unattended install from growing a log forever.
 */
export const DAEMON_LOG_MAX_BYTES = 1024 * 1024;

export interface CodegraphDaemonPaths {
  storageDir: string;
  socketPath: string;
  pidFile: string;
  portFile: string;
  refsFile: string;
  lockFile: string;
  /** Where the spawned daemon's stdout + stderr are recorded. */
  logFile: string;
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
  return process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR ?? join(appDataPath ?? fallbackAppDataDir(), "codegraph");
}

export function getDaemonPaths(storageDir: string): CodegraphDaemonPaths {
  return {
    storageDir,
    socketPath: join(storageDir, "codegraph-daemon.sock"),
    pidFile: join(storageDir, "codegraph-daemon.pid"),
    portFile: join(storageDir, "codegraph-daemon.port"),
    refsFile: join(storageDir, "codegraph-daemon.refs"),
    lockFile: join(storageDir, "codegraph-daemon.lock"),
    logFile: getDaemonLogPath(storageDir),
  };
}

/**
 * The daemon log sits next to the socket, which is what lets a client derive it
 * from the socket path alone when it has to name the file in an error.
 */
export function getDaemonLogPath(storageDir: string): string {
  return join(storageDir, "codegraph-daemon.log");
}

/**
 * Open the daemon log for the spawner to hand to the child as stdout + stderr.
 * Appends, so the output of a spawn that died is still there after the next one
 * starts — an intermittent startup failure is only diagnosable across attempts.
 * A log past `DAEMON_LOG_MAX_BYTES` is started over rather than grown.
 */
export function openDaemonLogFd(paths: CodegraphDaemonPaths): number {
  mkdirSync(dirname(paths.logFile), { recursive: true });
  try {
    if (statSync(paths.logFile).size > DAEMON_LOG_MAX_BYTES) return openSync(paths.logFile, "w");
  } catch {
    /* no log yet — the append below creates it */
  }
  return openSync(paths.logFile, "a");
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

/** Read the daemon's pid from its pid file; undefined when absent/unreadable. */
export function readDaemonPid(paths: CodegraphDaemonPaths): number | undefined {
  try {
    const pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export interface DaemonExitWaitOptions {
  /** Give up after this long (the daemon's own drain is hard-capped at ~3s). */
  timeoutMs?: number;
  /** Delay between lifecycle-file polls. */
  pollIntervalMs?: number;
}

export const DEFAULT_EXIT_TIMEOUT_MS = 10_000;
const DEFAULT_EXIT_POLL_INTERVAL_MS = 50;

/**
 * Wait for the daemon that owned `stalePid` to exit after a graceful
 * `shutdown` request (bd tea-rags-mcp-ji56r). Exit is observed through the
 * lifecycle files — the daemon's cleanup unlinks its pid file — with a
 * pid-liveness probe as backstop (a crashed daemon leaves the file behind).
 * Considered exited when the pid file is gone, its content changed (a fresh
 * daemon already took over), or the recorded pid no longer accepts signal 0.
 * Resolves true on exit, false when `timeoutMs` elapses first.
 */
export async function waitForDaemonExit(
  paths: CodegraphDaemonPaths,
  stalePid: number | undefined,
  opts?: DaemonExitWaitOptions,
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXIT_TIMEOUT_MS;
  const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULT_EXIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const current = readDaemonPid(paths);
    if (current === undefined || (stalePid !== undefined && current !== stalePid)) return true;
    if (stalePid !== undefined && !isPidAlive(stalePid)) return true;
    if (Date.now() + pollIntervalMs > deadline) return false;
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }
}

/** Signal-0 liveness probe (kill throws ESRCH once the process is gone). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll the refs file every 5s; once it has stayed at <= 0 for IDLE_SHUTDOWN_MS,
 * clear the interval and invoke onShutdown so the daemon releases the RW DuckDB
 * lock. The interval is `.unref()`'d so it never keeps the process alive on its
 * own. Mirrors the Qdrant embedded daemon idle watcher.
 */
export function scheduleIdleWatcher(paths: CodegraphDaemonPaths, onShutdown: () => void): NodeJS.Timeout {
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
