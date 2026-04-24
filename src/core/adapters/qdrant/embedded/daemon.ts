import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { QdrantOperationError, QdrantUnavailableError } from "../errors.js";
import { DaemonLock } from "./daemon-lock.js";
import {
  assertNoDowngrade,
  downloadQdrant,
  getBinaryPath,
  isBinaryUpToDate,
  QDRANT_VERSION,
  warnIfStaleBinary,
} from "./download.js";
import type { DaemonHandle, DaemonPaths, QdrantResolution, StartupPhase } from "./types.js";

const daemonLock = new DaemonLock();

export const EMBEDDED_MARKER = "embedded";
const READINESS_TIMEOUT_MS = 300_000;
const READINESS_POLL_INTERVAL_MS = 200;
const IDLE_SHUTDOWN_MS = 30_000;
const SPAWN_GRACE_MS = 500;

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for the daemon to become ready OR die.
 *
 * Qdrant 1.17 binds its HTTP port only after shard recovery finishes, so
 * /livez and /readyz are both unreachable during recovery. The only "alive"
 * signal during that window is the child pid. We poll /readyz with a short
 * cadence and bail immediately if the pid disappears — so a crashed daemon
 * is detected in ~500ms, while a slow cold recovery is allowed up to 5 min.
 */
export async function waitForDaemonReady(
  pid: number,
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; probe?: (url: string) => Promise<boolean> } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? READINESS_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? READINESS_POLL_INTERVAL_MS;
  const probe = opts.probe ?? probeHealth;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (!isPidAlive(pid)) {
      throw new Error(`Qdrant daemon (pid=${pid}) exited during startup`);
    }
    if (await probe(url)) return;
    await sleep(intervalMs);
  }

  throw new Error(`Qdrant daemon did not become ready within ${timeoutMs}ms`);
}

/**
 * Multi-core performance defaults for the embedded Qdrant daemon.
 * `0` means "auto" — Qdrant picks a value based on available CPUs.
 * User-provided QDRANT__* env vars take precedence.
 */
const MULTI_CORE_DEFAULTS: Readonly<Record<string, string>> = {
  QDRANT__STORAGE__PERFORMANCE__MAX_SEARCH_THREADS: "0",
  QDRANT__STORAGE__PERFORMANCE__MAX_OPTIMIZATION_THREADS: "0",
  QDRANT__STORAGE__PERFORMANCE__OPTIMIZER_CPU_BUDGET: "0",
  QDRANT__STORAGE__PERFORMANCE__ASYNC_SCORING_ENABLED: "true",
};

export function buildDaemonEnv(
  storagePath: string,
  port: number,
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const performanceDefaults: Record<string, string> = {};
  for (const [key, value] of Object.entries(MULTI_CORE_DEFAULTS)) {
    if (parentEnv[key] === undefined) performanceDefaults[key] = value;
  }

  return {
    ...parentEnv,
    ...performanceDefaults,
    QDRANT__STORAGE__STORAGE_PATH: storagePath,
    QDRANT__SERVICE__HTTP_PORT: String(port),
    QDRANT__SERVICE__GRPC_PORT: "0",
  };
}

export function getDaemonPaths(storagePath: string): DaemonPaths {
  return {
    pidFile: join(storagePath, "daemon.pid"),
    portFile: join(storagePath, "daemon.port"),
    refsFile: join(storagePath, "daemon.refs"),
    lockFile: join(storagePath, "daemon.lock"),
    startedAtFile: join(storagePath, "daemon.started_at"),
    storagePath,
  };
}

/**
 * Anything under this threshold since spawn is considered "starting" — short
 * retry window. Past it we treat the daemon as "recovering" — long retry window.
 */
const STARTING_PHASE_MS = 15_000;

function readStartedAt(paths: DaemonPaths): number | null {
  try {
    const v = parseInt(readFileSync(paths.startedAtFile, "utf-8").trim(), 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export function computeStartupPhase(paths: DaemonPaths, now: number = Date.now()): StartupPhase | null {
  if (!isDaemonAlive(paths)) return null;
  const startedAt = readStartedAt(paths);
  if (startedAt === null) return "recovering"; // unknown start time — assume the long wait
  return now - startedAt < STARTING_PHASE_MS ? "starting" : "recovering";
}

/* v8 ignore next 3 -- fallback for backward compat when DI paths not provided */
function fallbackAppDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function getStoragePath(appDataPath?: string): string {
  return process.env.QDRANT_EMBEDDED_STORAGE_PATH ?? join(appDataPath ?? fallbackAppDataDir(), "qdrant");
}

export function isDaemonAlive(paths: DaemonPaths): boolean {
  if (!existsSync(paths.pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function readRefs(paths: DaemonPaths): number {
  try {
    return parseInt(readFileSync(paths.refsFile, "utf-8").trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function incrementRefs(paths: DaemonPaths): number {
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = readRefs(paths) + 1;
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}

function decrementRefs(paths: DaemonPaths): number {
  const lock = daemonLock.acquire(paths.lockFile);
  try {
    const next = Math.max(0, readRefs(paths) - 1);
    writeFileSync(paths.refsFile, String(next), "utf-8");
    return next;
  } finally {
    if (lock) daemonLock.release(lock.fd);
  }
}

function cleanupDaemonFiles(paths: DaemonPaths): void {
  for (const f of [paths.pidFile, paths.portFile, paths.refsFile, paths.lockFile, paths.startedAtFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
}

const GRACEFUL_KILL_TIMEOUT_MS = 3000;

/**
 * Send SIGTERM, wait up to timeout, then SIGKILL if still alive.
 * Exported for testability.
 */
export async function gracefulKill(pid: number, timeoutMs = GRACEFUL_KILL_TIMEOUT_MS): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // already dead
  }

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // exited
    }
    await sleep(100);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already dead */
  }
}

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => {
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}

export async function resolveQdrantUrl(qdrantUrl?: string, appDataPath?: string): Promise<QdrantResolution> {
  if (qdrantUrl && qdrantUrl !== EMBEDDED_MARKER) {
    return { mode: "external", url: qdrantUrl };
  }

  if (!qdrantUrl) {
    const defaultUrl = "http://localhost:6333";
    if (await probeHealth(defaultUrl)) {
      return { mode: "external", url: defaultUrl };
    }
  }

  const handle = await ensureDaemon(appDataPath);
  return {
    mode: "embedded",
    url: handle.url,
    release: handle.release,
    reconnect: handle.reconnect,
    startupPhase: handle.startupPhase,
    pid: handle.pid,
    storagePath: handle.storagePath,
  };
}

/**
 * Build a reconnect callback that re-reads daemon.port and returns a new URL
 * if the daemon restarted on a different port. Returns null if port unchanged.
 */
function makeReconnect(paths: DaemonPaths, currentPort: number): () => string | null {
  return () => {
    if (!existsSync(paths.portFile) || !isDaemonAlive(paths)) return null;
    const newPort = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
    if (newPort === currentPort || isNaN(newPort)) return null;
    const newUrl = `http://127.0.0.1:${newPort}`;
    console.error(`[tea-rags] Qdrant daemon port changed: ${currentPort} → ${newPort}`);
    return newUrl;
  };
}

const LOCK_WAIT_INTERVAL_MS = 200;
const LOCK_WAIT_TIMEOUT_MS = READINESS_TIMEOUT_MS + 5000;

/**
 * Wait for another process to finish starting the daemon.
 * Returns when the lock file disappears (or timeout).
 */
async function waitForDaemon(paths: DaemonPaths): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < LOCK_WAIT_TIMEOUT_MS) {
    if (!daemonLock.isHeld(paths.lockFile)) return;
    await sleep(LOCK_WAIT_INTERVAL_MS);
  }
}

function readPidFromFile(paths: DaemonPaths): number {
  return parseInt(readFileSync(paths.pidFile, "utf-8").trim(), 10);
}

function makeDaemonHandle(paths: DaemonPaths, port: number, url: string, pid: number): DaemonHandle {
  return {
    url,
    pid,
    storagePath: paths.storagePath,
    release: () => {
      const remaining = decrementRefs(paths);
      console.error(`[tea-rags] Released Qdrant ref (remaining=${remaining})`);
    },
    reconnect: makeReconnect(paths, port),
    startupPhase: () => computeStartupPhase(paths),
  };
}

async function ensureDaemon(appDataPath?: string): Promise<DaemonHandle> {
  const storagePath = getStoragePath(appDataPath);
  mkdirSync(storagePath, { recursive: true });
  const paths = getDaemonPaths(storagePath);

  // Fast path: attach to running daemon (no lock needed).
  // We intentionally do NOT probe /readyz here — Qdrant binds its HTTP port
  // only after shard recovery, so a legitimately-alive daemon would look
  // unreachable during cold start. pid-liveness is the authoritative signal.
  if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
    const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
    const url = `http://127.0.0.1:${port}`;
    const pid = readPidFromFile(paths);
    const refs = incrementRefs(paths);
    console.error(`[tea-rags] Attached to Qdrant daemon (pid=${pid}, port=${port}, refs=${refs})`);
    warnIfStaleBinary(appDataPath);
    return makeDaemonHandle(paths, port, url, pid);
  }

  // Slow path: acquire lock for daemon spawn
  const lock = daemonLock.acquire(paths.lockFile);
  if (!lock) {
    // Another process is starting the daemon — wait and retry
    console.error("[tea-rags] Daemon lock held by another process, waiting...");
    await waitForDaemon(paths);
    return ensureDaemon(appDataPath);
  }

  try {
    // Double-check: daemon may have appeared while we waited for the lock.
    // Same rule as fast path — pid-alive is authoritative, don't probe HTTP.
    if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
      const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
      const url = `http://127.0.0.1:${port}`;
      const pid = readPidFromFile(paths);
      const refs = incrementRefs(paths);
      console.error(`[tea-rags] Attached to Qdrant daemon (pid=${pid}, port=${port}, refs=${refs})`);
      return makeDaemonHandle(paths, port, url, pid);
    }

    cleanupDaemonFiles(paths);

    if (!isBinaryUpToDate(appDataPath)) {
      assertNoDowngrade(appDataPath);
      console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION}...`);
      await downloadQdrant(undefined, undefined, appDataPath);
    }

    const port = await findFreePort();
    const binaryPath = getBinaryPath(undefined, appDataPath);

    const child = spawn(binaryPath, ["--disable-telemetry"], {
      cwd: dirname(binaryPath),
      detached: true,
      stdio: "ignore",
      env: buildDaemonEnv(storagePath, port),
    });
    child.unref();

    const { pid } = child;
    if (pid === undefined) {
      throw new QdrantOperationError("spawn", "daemon failed to spawn — no PID assigned");
    }

    writeFileSync(paths.pidFile, String(pid), "utf-8");
    writeFileSync(paths.portFile, String(port), "utf-8");
    writeFileSync(paths.refsFile, "1", "utf-8");
    writeFileSync(paths.startedAtFile, String(Date.now()), "utf-8");

    const url = `http://127.0.0.1:${port}`;

    // Brief grace to catch immediate spawn failures (bad env, corrupt storage
    // panics, missing binary deps). We do NOT wait for /readyz here — Qdrant
    // only binds HTTP after shard recovery, which can take minutes on large
    // collections. QdrantManager converts connection errors into
    // QdrantStartingError / QdrantRecoveringError while the pid is alive.
    await sleep(SPAWN_GRACE_MS);
    if (!isPidAlive(pid)) {
      cleanupDaemonFiles(paths);
      throw new QdrantUnavailableError(
        url,
        new Error(`Qdrant daemon (pid=${pid}) exited ${SPAWN_GRACE_MS}ms after spawn`),
      );
    }

    console.error(`[tea-rags] Qdrant daemon spawned (pid=${pid}, port=${port}, recovery may be in progress)`);
    scheduleIdleWatcher(paths, pid);
    return makeDaemonHandle(paths, port, url, pid);
  } finally {
    daemonLock.release(lock.fd);
  }
}

function scheduleIdleWatcher(paths: DaemonPaths, pid: number): void {
  let idleSince: number | null = null;

  const interval = setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(interval);
      cleanupDaemonFiles(paths);
      return;
    }

    const refs = readRefs(paths);
    if (refs <= 0) {
      if (idleSince === null) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= IDLE_SHUTDOWN_MS) {
        console.error(`[tea-rags] Qdrant daemon idle, shutting down`);
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          /* ignore */
        }
        cleanupDaemonFiles(paths);
        clearInterval(interval);
      }
    } else {
      idleSince = null;
    }
  }, 5000);

  interval.unref();
}
