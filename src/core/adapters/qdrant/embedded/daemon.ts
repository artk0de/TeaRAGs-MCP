import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { QdrantOperationError, QdrantUnavailableError } from "../errors.js";
import { downloadQdrant, getBinaryPath, isBinaryUpToDate, QDRANT_VERSION } from "./download.js";
import type { DaemonHandle, DaemonPaths, QdrantResolution } from "./types.js";

export const EMBEDDED_MARKER = "embedded";
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 200;
const IDLE_SHUTDOWN_MS = 30_000;

export function getDaemonPaths(storagePath: string): DaemonPaths {
  return {
    pidFile: join(storagePath, "daemon.pid"),
    portFile: join(storagePath, "daemon.port"),
    refsFile: join(storagePath, "daemon.refs"),
    storagePath,
  };
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
  const next = readRefs(paths) + 1;
  writeFileSync(paths.refsFile, String(next), "utf-8");
  return next;
}

function decrementRefs(paths: DaemonPaths): number {
  const next = Math.max(0, readRefs(paths) - 1);
  writeFileSync(paths.refsFile, String(next), "utf-8");
  return next;
}

function cleanupDaemonFiles(paths: DaemonPaths): void {
  for (const f of [paths.pidFile, paths.portFile, paths.refsFile]) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
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
  return { mode: "embedded", url: handle.url, release: handle.release, reconnect: handle.reconnect };
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

async function ensureDaemon(appDataPath?: string): Promise<DaemonHandle> {
  const storagePath = getStoragePath(appDataPath);
  mkdirSync(storagePath, { recursive: true });
  const paths = getDaemonPaths(storagePath);

  if (isDaemonAlive(paths) && existsSync(paths.portFile)) {
    const port = parseInt(readFileSync(paths.portFile, "utf-8").trim(), 10);
    const url = `http://127.0.0.1:${port}`;
    if (await probeHealth(url)) {
      const refs = incrementRefs(paths);
      console.error(`[tea-rags] Attached to Qdrant daemon (port ${port}, refs=${refs})`);
      return {
        url,
        release: () => {
          const remaining = decrementRefs(paths);
          console.error(`[tea-rags] Released Qdrant ref (remaining=${remaining})`);
        },
        reconnect: makeReconnect(paths, port),
      };
    }
  }

  cleanupDaemonFiles(paths);

  if (!isBinaryUpToDate(appDataPath)) {
    console.error(`[tea-rags] Downloading Qdrant v${QDRANT_VERSION}...`);
    await downloadQdrant(undefined, undefined, appDataPath);
  }

  const port = await findFreePort();
  const binaryPath = getBinaryPath(undefined, appDataPath);

  const child = spawn(binaryPath, ["--disable-telemetry"], {
    cwd: dirname(binaryPath),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      QDRANT__STORAGE__STORAGE_PATH: storagePath,
      QDRANT__SERVICE__HTTP_PORT: String(port),
      QDRANT__SERVICE__GRPC_PORT: "0",
    },
  });
  child.unref();

  const { pid } = child;
  if (pid === undefined) {
    throw new QdrantOperationError("spawn", "daemon failed to spawn — no PID assigned");
  }

  writeFileSync(paths.pidFile, String(pid), "utf-8");
  writeFileSync(paths.portFile, String(port), "utf-8");
  writeFileSync(paths.refsFile, "1", "utf-8");

  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < HEALTH_CHECK_TIMEOUT_MS) {
    if (await probeHealth(url)) {
      console.error(`[tea-rags] Qdrant daemon started (pid=${pid}, port=${port})`);
      scheduleIdleWatcher(paths, pid);
      return {
        url,
        release: () => {
          const remaining = decrementRefs(paths);
          console.error(`[tea-rags] Released Qdrant ref (remaining=${remaining})`);
        },
        reconnect: makeReconnect(paths, port),
      };
    }
    await sleep(HEALTH_CHECK_INTERVAL_MS);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
  cleanupDaemonFiles(paths);
  throw new QdrantUnavailableError(url, new Error(`Qdrant daemon failed to start within ${HEALTH_CHECK_TIMEOUT_MS}ms`));
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
