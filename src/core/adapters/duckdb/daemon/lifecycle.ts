import { createHash } from "node:crypto";
import { mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DaemonLock } from "../../qdrant/embedded/daemon-lock.js";
import { getBuildFingerprint, readOnDiskBuildFingerprint } from "./build-fingerprint.js";

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
  /**
   * Single-instance ownership lock of the key directory (bd tea-rags-mcp-imgjx):
   * held by the owning daemon for its whole lifetime, stamped with its pid. See
   * `claimDaemonOwnership`.
   */
  ownerFile: string;
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
    ownerFile: join(keyDir, "codegraph-daemon.owner"),
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
  return getDaemonPathsForBuild(storageDir, getBuildFingerprint());
}

/**
 * The keyed lifecycle files of the daemon of build `fingerprint` under
 * `storageDir` — the layout `getDaemonPaths` gives for this process's loaded
 * build, for any build.
 */
export function getDaemonPathsForBuild(storageDir: string, fingerprint: string): CodegraphDaemonPaths {
  const buildDir = join(storageDir, getBuildKey(fingerprint));
  return { ...daemonPathsForKeyDir(buildDir), storageDir };
}

/**
 * How a client process's build relates to the build on disk, and therefore
 * which key directory it addresses (bd tea-rags-mcp-llrja):
 * - `own-build` — loaded == on disk (or the fingerprint env override): its own
 *   build's key dir, exactly `getDaemonPaths`;
 * - `on-disk-build` — the process predates a rebuild / `npm link` / upgrade:
 *   the ON-DISK build's key dir, because every daemon spawned from this tree
 *   runs that build and keys itself by it. The build handshake then settles
 *   what the stale process may do there (bd tea-rags-mcp-1wr7p);
 * - `build-tree-gone` — the loaded tree is unreadable: nothing can be spawned
 *   from it, so only a still-running daemon of the loaded build is reachable.
 */
export type CodegraphDaemonClientAddressing = "own-build" | "on-disk-build" | "build-tree-gone";

/** Which daemon a client process talks to right now — see `resolveDaemonClientTarget`. */
export interface CodegraphDaemonClientTarget {
  readonly addressing: CodegraphDaemonClientAddressing;
  readonly paths: CodegraphDaemonPaths;
  /** The build this process loaded. */
  readonly loadedFingerprint: string;
  /** The build on disk now; undefined when the tree is gone. */
  readonly onDiskFingerprint: string | undefined;
}

/** The two views of a process's build a client target is decided from. */
export interface DaemonClientBuildSource {
  readonly loaded: () => string;
  readonly onDisk: () => string | undefined;
}

const PROCESS_BUILD_SOURCE: DaemonClientBuildSource = {
  loaded: getBuildFingerprint,
  onDisk: readOnDiskBuildFingerprint,
};

/**
 * THE rule for which key directory a CLIENT process addresses (bd
 * tea-rags-mcp-llrja) — the spawner's alive-check and spawn lock and the
 * pool's socket connect all resolve through it, so they never disagree.
 *
 * Keying a client by its LOADED fingerprint broke as soon as a long-lived
 * server outlived `npm run build`: it kept addressing the old key dir while the
 * daemon it spawned from disk — or a fresh process had already spawned — ran
 * the new build in the new key dir, and every graph call waited out the connect
 * window on a socket that never appeared. Called per connect, never cached:
 * the build on disk moves under a running process. A daemon keys itself by its
 * own loaded build (`getDaemonPaths`), which is the on-disk build it was
 * spawned from.
 */
export function resolveDaemonClientTarget(
  storageDir: string,
  build: DaemonClientBuildSource = PROCESS_BUILD_SOURCE,
): CodegraphDaemonClientTarget {
  const loadedFingerprint = build.loaded();
  const onDiskFingerprint = build.onDisk();
  if (onDiskFingerprint === undefined) {
    return {
      addressing: "build-tree-gone",
      paths: getDaemonPathsForBuild(storageDir, loadedFingerprint),
      loadedFingerprint,
      onDiskFingerprint,
    };
  }
  return {
    addressing: onDiskFingerprint === loadedFingerprint ? "own-build" : "on-disk-build",
    paths: getDaemonPathsForBuild(storageDir, onDiskFingerprint),
    loadedFingerprint,
    onDiskFingerprint,
  };
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
  return readPidFile(paths.pidFile);
}

/** What `claimDaemonOwnership` found: this process owns the key dir, or who does. */
export type DaemonOwnershipClaim =
  | { owned: true; release: () => void }
  | { owned: false; ownerPid: number | undefined };

/**
 * Claim single-instance ownership of a daemon's key directory (bd
 * tea-rags-mcp-imgjx). A daemon calls this FIRST — before it opens a DuckDB
 * file, unlinks a socket or writes its pid file — and holds the claim until its
 * shutdown cleanup releases it. Two daemons of one build spawned in the same
 * window used to both run: the second's `listen` unlinked the first's socket, so
 * the first became unreachable while still holding the RW lock of whatever
 * collection it had opened.
 *
 * The claim is a `DaemonLock` on `ownerFile`: an atomic exclusive create stamped
 * with the owner's pid. A live owner (signal 0 answers, or EPERM) makes the
 * claim fail; a dead owner's file — a crashed or SIGKILLed daemon never ran its
 * cleanup — is taken over, so a leftover never blocks the respawn. The pid file
 * is deliberately NOT the claim: it is written after `listen` and spawners read
 * it as "the daemon is reachable", a stronger statement than "owned".
 */
export function claimDaemonOwnership(paths: CodegraphDaemonPaths): DaemonOwnershipClaim {
  mkdirSync(dirname(paths.ownerFile), { recursive: true });
  const lock = daemonLock.acquire(paths.ownerFile);
  if (!lock) return { owned: false, ownerPid: readPidFile(paths.ownerFile) };
  let released = false;
  return {
    owned: true,
    release: () => {
      if (released) return;
      released = true;
      daemonLock.release(lock.fd);
    },
  };
}

function readPidFile(file: string): number | undefined {
  try {
    const pid = parseInt(readFileSync(file, "utf-8").trim(), 10);
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
