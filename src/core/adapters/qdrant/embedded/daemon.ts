import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { QdrantOperationError, QdrantUnavailableError } from "../errors.js";
import { compareSemver, isSemver } from "../required-version.js";
import { QDRANT_CRASH_LOG_NAME } from "./corruption-recovery.js";
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

/**
 * Low-memory defaults applied when low-memory mode is on. Qdrant 1.18 exposes a
 * single runtime lever — `storage.low_memory_mode` — that supersedes the prior
 * per-key on-disk overrides. `no_populate` means "no resident vectors + skip the
 * mmap prefetch for vectors / HNSW / payload": OOM-safe on a RAM-constrained
 * host (slower) without mutating any persisted collection settings. Applied as a
 * default only when the user has not already set the key, so explicit `QDRANT__*`
 * overrides still win.
 */
const LOW_MEMORY_DEFAULTS: Readonly<Record<string, string>> = {
  QDRANT__STORAGE__LOW_MEMORY_MODE: "no_populate",
};

export function buildDaemonEnv(
  storagePath: string,
  port: number,
  parentEnv: NodeJS.ProcessEnv = process.env,
  lowMemory = false,
): NodeJS.ProcessEnv {
  const performanceDefaults: Record<string, string> = {};
  for (const [key, value] of Object.entries(MULTI_CORE_DEFAULTS)) {
    if (parentEnv[key] === undefined) performanceDefaults[key] = value;
  }

  const lowMemoryDefaults: Record<string, string> = {};
  if (lowMemory) {
    for (const [key, value] of Object.entries(LOW_MEMORY_DEFAULTS)) {
      if (parentEnv[key] === undefined) lowMemoryDefaults[key] = value;
    }
  }

  return {
    ...parentEnv,
    ...performanceDefaults,
    ...lowMemoryDefaults,
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

/**
 * Best-effort probe of the RUNNING daemon's reported version via a raw GET on
 * the root endpoint (Qdrant returns `{version}` there). Mirrors the swallow-all
 * shape of `QdrantManager.getServerVersion`, but stays local to the embedded
 * adapter — daemon.ts must not reach up into the REST client. Returns the
 * reported version string, or `undefined` on ANY failure: this is a staleness
 * probe and MUST NOT throw, so it can never break daemon attach. `fetchImpl` is
 * injected for tests; production uses the global `fetch`.
 */
export async function probeDaemonVersion(
  url: string,
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${url}/`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown } | null;
    const raw = body?.version;
    return typeof raw === "string" ? raw : undefined;
  } catch {
    return undefined;
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

const DAEMON_EXIT_POLL_INTERVAL_MS = 150;
// ~10s graceful window: the single-process WAL lock must release before the
// upgraded binary can cold-spawn, else it crashes with `Wal error ... WouldBlock`.
const DAEMON_EXIT_MAX_POLLS = 67;
const DAEMON_EXIT_SIGKILL_MAX_POLLS = 20;

/**
 * Dependencies for {@link evictStaleDaemon}, injected so the stale-restart path
 * is unit-testable without a real network probe, OS signals, or wall-clock
 * sleeps. Production wires the real `fetch` probe, `process.kill`, and timers.
 */
export interface EvictStaleDaemonDeps {
  probeVersion: (url: string) => Promise<string | undefined>;
  killPid: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
  binaryUpToDate: (appDataPath?: string) => boolean;
}

const defaultEvictStaleDaemonDeps: EvictStaleDaemonDeps = {
  probeVersion: probeDaemonVersion,
  killPid: (pid, signal) => {
    process.kill(pid, signal);
  },
  isAlive: isPidAlive,
  sleep,
  binaryUpToDate: isBinaryUpToDate,
};

/** Poll until the pid is gone (or the cap is hit). Returns whether it exited. */
async function waitForDaemonExit(pid: number, deps: EvictStaleDaemonDeps, maxPolls: number): Promise<boolean> {
  for (let poll = 0; poll < maxPolls; poll++) {
    if (!deps.isAlive(pid)) return true;
    await deps.sleep(DAEMON_EXIT_POLL_INTERVAL_MS);
  }
  return !deps.isAlive(pid);
}

/** SIGTERM, wait for a graceful exit, then SIGKILL + wait if it won't die. */
async function terminateAndWait(pid: number, deps: EvictStaleDaemonDeps): Promise<void> {
  try {
    deps.killPid(pid, "SIGTERM");
  } catch {
    return; // already dead — nothing holds the WAL lock
  }
  if (await waitForDaemonExit(pid, deps, DAEMON_EXIT_MAX_POLLS)) return;

  // Still holding the exclusive WAL lock past the graceful window — force it
  // down so the cold-spawn doesn't crash with `Wal error ... WouldBlock`.
  try {
    deps.killPid(pid, "SIGKILL");
  } catch {
    return; // exited between checks
  }
  await waitForDaemonExit(pid, deps, DAEMON_EXIT_SIGKILL_MAX_POLLS);
}

/**
 * Evict the running daemon when it is stale relative to the pinned version.
 *
 * A binary auto-upgrade refreshes the on-disk binary + version file, but the
 * running daemon only adopts it at the next cold spawn. Under sustained MCP use
 * the daemon never goes idle, so that cold spawn never fires and the OLD process
 * keeps serving the OLD version — invisible to `warnIfStaleBinary`, which
 * compares files, never the live process. When the on-disk binary IS current
 * but the RUNNING daemon reports an older version, terminate it (SIGTERM, then
 * SIGKILL if it ignores the term) and remove its daemon files so the caller
 * cold-spawns the upgraded binary.
 *
 * Conservative by construction: returns false (attach as-is) when the binary is
 * not yet current, when the probe fails (cannot confirm staleness), or when the
 * daemon reports a version >= pinned (never downgrade — that is
 * `assertNoDowngrade`'s job). Returns true only after the stale process has
 * exited and its files are cleaned; the caller must then fall through to the
 * cold-spawn path.
 */
export async function evictStaleDaemon(
  paths: DaemonPaths,
  pid: number,
  url: string,
  appDataPath?: string,
  deps: EvictStaleDaemonDeps = defaultEvictStaleDaemonDeps,
): Promise<boolean> {
  // A live daemon can only be upgraded once the on-disk binary is current; until
  // then the deferred-to-idle path (warnIfStaleBinary) owns the notice.
  if (!deps.binaryUpToDate(appDataPath)) return false;

  const running = await deps.probeVersion(url);
  if (running === undefined || !isSemver(running)) return false;
  if (compareSemver(running, QDRANT_VERSION) >= 0) return false;

  console.error(
    `[tea-rags] Running Qdrant daemon is stale (running=${running}, pinned=${QDRANT_VERSION}); ` +
      `restarting to load the upgraded binary.`,
  );

  await terminateAndWait(pid, deps);
  cleanupDaemonFiles(paths);
  return true;
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

export async function resolveQdrantUrl(
  qdrantUrl?: string,
  appDataPath?: string,
  lowMemory = false,
): Promise<QdrantResolution> {
  if (qdrantUrl && qdrantUrl !== EMBEDDED_MARKER) {
    return { mode: "external", url: qdrantUrl };
  }

  if (!qdrantUrl) {
    const defaultUrl = "http://localhost:6333";
    if (await probeHealth(defaultUrl)) {
      return { mode: "external", url: defaultUrl };
    }
  }

  const handle = await ensureDaemon(appDataPath, lowMemory);
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
 * Build a reconnect callback that fully re-resolves the embedded daemon URL.
 *
 * Two paths:
 *  - Live daemon: re-read daemon.port; return a new URL only if the port moved,
 *    null if unchanged.
 *  - Dead daemon (the rebuild / restart window — pid gone, files cleaned): the
 *    daemon cannot be re-attached, so `respawn` spawns a fresh one and its URL
 *    is returned. Without this the active connection would be stuck on a dead
 *    port until the whole MCP process restarts, since `ensureDaemon` (the only
 *    spawn path) otherwise runs just once at bootstrap.
 *
 * `respawn` is injected so the dead-daemon branch is testable without spawning a
 * real Qdrant process; production wires it to `ensureDaemon`.
 */
export function makeReconnect(
  paths: DaemonPaths,
  currentPort: number,
  respawn: () => Promise<string>,
): () => Promise<string | null> {
  let knownPort = currentPort;
  return async () => {
    if (existsSync(paths.portFile) && isDaemonAlive(paths)) {
      const newPort = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
      if (isNaN(newPort) || newPort === knownPort) return null;
      console.error(`[tea-rags] Qdrant daemon port changed: ${knownPort} → ${newPort}`);
      knownPort = newPort;
      return `http://127.0.0.1:${newPort}`;
    }

    // Daemon is gone — re-resolve by respawning a fresh one.
    console.error(`[tea-rags] Qdrant daemon gone — re-resolving (respawn)`);
    const url = await respawn();
    const moved = /:(\d+)$/.exec(url);
    if (moved) knownPort = parseInt(moved[1], 10);
    return url;
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

function makeDaemonHandle(
  paths: DaemonPaths,
  port: number,
  url: string,
  pid: number,
  appDataPath?: string,
  lowMemory = false,
): DaemonHandle {
  return {
    url,
    pid,
    storagePath: paths.storagePath,
    release: () => {
      const remaining = decrementRefs(paths);
      console.error(`[tea-rags] Released Qdrant ref (remaining=${remaining})`);
    },
    reconnect: makeReconnect(paths, port, async () => (await ensureDaemon(appDataPath, lowMemory)).url),
    startupPhase: () => computeStartupPhase(paths),
  };
}

async function ensureDaemon(appDataPath?: string, lowMemory = false): Promise<DaemonHandle> {
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

    // A binary auto-upgrade refreshes the on-disk binary, but a daemon under
    // sustained MCP use never goes idle, so the deferred-to-idle cold-spawn
    // upgrade never fires and the OLD process serves the OLD version forever —
    // invisible to warnIfStaleBinary (file-based). If the binary is current but
    // the running daemon is older than pinned, evict it and cold-spawn below.
    if (!(await evictStaleDaemon(paths, pid, url, appDataPath))) {
      const refs = incrementRefs(paths);
      console.error(`[tea-rags] Attached to Qdrant daemon (pid=${pid}, port=${port}, refs=${refs})`);
      warnIfStaleBinary(appDataPath);
      return makeDaemonHandle(paths, port, url, pid, appDataPath, lowMemory);
    }
    // Stale daemon evicted — fall through to the slow-path cold spawn.
  }

  // Slow path: acquire lock for daemon spawn
  const lock = daemonLock.acquire(paths.lockFile);
  if (!lock) {
    // Another process is starting the daemon — wait and retry
    console.error("[tea-rags] Daemon lock held by another process, waiting...");
    await waitForDaemon(paths);
    return ensureDaemon(appDataPath, lowMemory);
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
      return makeDaemonHandle(paths, port, url, pid, appDataPath, lowMemory);
    }

    cleanupDaemonFiles(paths);

    if (!isBinaryUpToDate(appDataPath)) {
      assertNoDowngrade(appDataPath);
      console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION}...`);
      await downloadQdrant(undefined, undefined, appDataPath);
    }

    const port = await findFreePort();
    const binaryPath = getBinaryPath(undefined, appDataPath);

    // Pipe qdrant's stderr to a per-storage crash log (truncated each cold
    // spawn) so a shard-load panic is recoverable instead of vanishing into
    // /dev/null. A killed reindex can leave a corrupt versioned collection whose
    // WAL replay panics on the NEXT boot and bricks the WHOLE daemon; the client
    // reads this log to quarantine the named collection and respawn clean
    // (see corruption-recovery.ts, tea-rags-mcp-mh7nr). stdout stays discarded.
    const crashLogFd = openSync(join(storagePath, QDRANT_CRASH_LOG_NAME), "w");
    const child = spawn(binaryPath, ["--disable-telemetry"], {
      cwd: dirname(binaryPath),
      detached: true,
      stdio: ["ignore", "ignore", crashLogFd],
      env: buildDaemonEnv(storagePath, port, process.env, lowMemory),
    });
    child.unref();
    closeSync(crashLogFd); // the detached child holds its own dup of the fd

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
    return makeDaemonHandle(paths, port, url, pid, appDataPath, lowMemory);
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
