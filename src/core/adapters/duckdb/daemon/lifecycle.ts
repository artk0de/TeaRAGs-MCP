import { createHash } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DaemonLock } from "../../qdrant/embedded/daemon-lock.js";
import { getBuildFingerprint } from "./build-fingerprint.js";

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
  /**
   * The base storage dir `getDaemonPaths` was called with (bd
   * tea-rags-mcp-42hno). NOT the directory the files sit in — that is
   * `buildDir`. For the legacy and for-key-dir views the two coincide.
   */
  storageDir: string;
  /**
   * The directory the lifecycle files actually sit in: `<storageDir>/<build
   * key>` for the keyed view, the plain dir for the legacy / for-key-dir
   * views. A daemon's cleanup and the orphan sweep remove THIS directory.
   */
  buildDir: string;
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
 * Resolve the on-disk directory that holds the codegraph daemon's per-build
 * key directories. Honors TEA_RAGS_CODEGRAPH_DAEMON_DIR for test/CI
 * overrides; otherwise nests `codegraph/` under the app-data dir.
 */
export function getStorageDir(appDataPath?: string): string {
  return process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR ?? join(appDataPath ?? fallbackAppDataDir(), "codegraph");
}

/**
 * The per-build key directory name under the storage dir (bd
 * tea-rags-mcp-42hno): `b-` plus 8 hex chars of SHA-256 over the build
 * fingerprint. The fingerprint is a long, path-bearing string — unusable as a
 * directory name — so the hash is the stable short form. The name is kept
 * SHORT on purpose: a unix socket path is bounded by the 104-byte `sun_path`
 * on macOS, the key dir sits between the storage dir and
 * `codegraph-daemon.sock`, and the storage dir itself can be a deep tmp path.
 * Eight hex chars distinguish the handful of builds live on one machine with
 * a collision probability far below anything observable; even a collision
 * merely merges two builds onto one daemon, where the retained handshake
 * still arbitrates. Builds normally never share a key, so they never share a
 * daemon socket: `npm link` re-pointed at another checkout, or a rebuild,
 * addresses a DIFFERENT daemon instead of draining a shared one.
 */
export function getBuildKey(fingerprint: string = getBuildFingerprint()): string {
  return `b-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 8)}`;
}

/**
 * The lifecycle-file layout for ONE daemon whose files sit in `keyDir` — the
 * single place that knows the layout. `getDaemonPaths` (own build),
 * `getLegacyDaemonPaths` (pre-keying migration) and the pool's
 * `drainStaleDaemon` (recovered from a socket path) all resolve through it.
 */
export function daemonPathsForKeyDir(keyDir: string): CodegraphDaemonPaths {
  return {
    storageDir: keyDir,
    buildDir: keyDir,
    socketPath: join(keyDir, "codegraph-daemon.sock"),
    pidFile: join(keyDir, "codegraph-daemon.pid"),
    portFile: join(keyDir, "codegraph-daemon.port"),
    refsFile: join(keyDir, "codegraph-daemon.refs"),
    lockFile: join(keyDir, "codegraph-daemon.lock"),
    logFile: join(keyDir, "codegraph-daemon.log"),
  };
}

/**
 * THIS build's lifecycle files (bd tea-rags-mcp-42hno): the five lifecycle
 * files plus the log nest under the per-build key directory, so the spawner,
 * the daemon and every client pool that call THIS function address the same
 * daemon. `storageDir` stays the base so the value can ride the spawn env
 * (`TEA_RAGS_CODEGRAPH_DAEMON_DIR`) without re-keying on the daemon side.
 */
export function getDaemonPaths(storageDir: string): CodegraphDaemonPaths {
  const buildDir = join(storageDir, getBuildKey());
  return { ...daemonPathsForKeyDir(buildDir), storageDir };
}

/**
 * The pre-keying (42hno) layout: lifecycle files directly in the storage dir.
 * The one-time migration in the pool reads a legacy daemon through this view —
 * drain it if alive, then unlink — after which the layout is gone for good.
 */
export function getLegacyDaemonPaths(storageDir: string): CodegraphDaemonPaths {
  return daemonPathsForKeyDir(storageDir);
}

/**
 * The daemon log sits next to the socket, which is what lets a client derive it
 * from the socket path alone when it has to name the file in an error. The arg
 * is the directory the lifecycle files sit in (the build-key dir for a keyed
 * daemon).
 */
export function getDaemonLogPath(keyDir: string): string {
  return join(keyDir, "codegraph-daemon.log");
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
 * Signal-0 liveness probe for a recorded daemon pid, with EPERM counted as
 * ALIVE (mirrors the `DaemonLock` probe): the pid is taken by a process this
 * user may not signal — a live daemon is not ours to sweep. Only ESRCH counts
 * as gone.
 */
export function isDaemonPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** What one build-key directory says about the daemon that owns it. */
export interface DaemonKeyDirStatus {
  /** The key directory itself (`<storageDir>/build-<hash>`). */
  keyDir: string;
  /** The daemon's lifecycle paths resolved through `daemonPathsForKeyDir`. */
  paths: CodegraphDaemonPaths;
  /** The recorded pid; undefined when the dir holds no readable pid file. */
  pid: number | undefined;
  /** Whether that pid still accepts signal 0. */
  alive: boolean;
}

/** Key-directory shape `getBuildKey` produces — anything else is not ours to sweep. */
const BUILD_KEY_DIR_PATTERN = /^b-[0-9a-f]{8}$/;

/**
 * Enumerate the build-key directories under `storageDir` (bd
 * tea-rags-mcp-42hno). A dir that holds no readable pid reports
 * `pid: undefined, alive: false` — the shape a crashed-before-listen spawn
 * leaves, and an orphan to the sweep.
 */
export function listDaemonKeyDirs(storageDir: string): DaemonKeyDirStatus[] {
  let entries: string[];
  try {
    entries = readdirSync(storageDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && BUILD_KEY_DIR_PATTERN.test(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }
  return entries.map((name) => {
    const paths = daemonPathsForKeyDir(join(storageDir, name));
    const pid = readDaemonPid(paths);
    return { keyDir: paths.buildDir, paths, pid, alive: pid !== undefined && isDaemonPidAlive(pid) };
  });
}

/**
 * Remove a build-key directory whose daemon is gone: lifecycle files, log and
 * all. Refuses (returns false) when the spawn lock inside it is still held —
 * a concurrent spawner may be mid-flight into that dir, and yanking the lock
 * file out from under it would break the single-flight guard. Acquiring the
 * lock first is what excludes that race; the release's unlink then finds the
 * dir already gone and is swallowed.
 */
function removeDeadKeyDir(status: DaemonKeyDirStatus): boolean {
  const lock = daemonLock.acquire(status.paths.lockFile);
  if (!lock) return false;
  try {
    rmSync(status.keyDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    daemonLock.release(lock.fd); // swallows the ENOENT once the dir (and lock file) is gone
  }
}

/**
 * Remove every build-key directory under `storageDir` whose daemon pid is
 * dead or absent (bd tea-rags-mcp-42hno). Run by the spawn path so builds
 * that come and go do not litter key dirs, and by `doctor --restart` as the
 * orphan sweep. Returns the removed directories; a live daemon's dir is never
 * touched, and a dead-pid dir whose spawn lock is held is skipped.
 */
export function sweepOrphanedDaemonKeyDirs(storageDir: string): string[] {
  const swept: string[] = [];
  for (const status of listDaemonKeyDirs(storageDir)) {
    if (status.alive) continue;
    if (removeDeadKeyDir(status)) swept.push(status.keyDir);
  }
  return swept;
}

/**
 * Unlink the five lifecycle files of ONE daemon (its own key only — the
 * layout makes "only its own" automatic, 42hno). Idempotent: missing-file
 * errors are swallowed. Shared by the daemon's shutdown cleanup and the
 * pool's legacy-layout migration.
 */
export function unlinkDaemonFiles(paths: CodegraphDaemonPaths): void {
  for (const f of [paths.socketPath, paths.pidFile, paths.portFile, paths.refsFile, paths.lockFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
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
