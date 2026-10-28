/**
 * A client whose signal-0 probe of the machine daemon is DENIED (EPERM) — a
 * tea-rags CLI inside Codex's macOS seatbelt sandbox — must attach to the
 * recorded daemon, never wipe its pid/port files and cold-spawn a second Qdrant
 * over the same storage (bd tea-rags-mcp-hdl65).
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  evictStaleDaemon,
  findRecordedDaemon,
  getDaemonPaths,
  isDaemonAlive,
  isPidAlive,
  resolveQdrantUrl,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";
import type * as DownloadModule from "../../../../../src/core/adapters/qdrant/embedded/download.js";
import type { DaemonPaths, QdrantResolution } from "../../../../../src/core/adapters/qdrant/embedded/types.js";

vi.mock("../../../../../src/core/adapters/qdrant/embedded/download.js", async (importOriginal) => {
  const actual = await importOriginal<typeof DownloadModule>();
  return {
    ...actual,
    downloadQdrant: vi.fn(async () => {
      throw new Error("a sandboxed attach must never reach the cold-spawn download");
    }),
    warnIfStaleBinary: vi.fn(),
  };
});

/** Machine daemon pid as the sandbox sees it: it exists, but signalling it is denied. */
const SANDBOXED_DAEMON_PID = 49_711;
const GONE_DAEMON_PID = 999_999_998;

function denySignalsTo(pid: number): void {
  const realKill = process.kill.bind(process);
  vi.spyOn(process, "kill").mockImplementation((target: number, signal?: string | number) => {
    if (target === pid) throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    return realKill(target, signal);
  });
}

function recordDaemon(paths: DaemonPaths, pid: number, port: number): void {
  writeFileSync(paths.pidFile, String(pid), "utf-8");
  writeFileSync(paths.portFile, String(port), "utf-8");
}

/** A port nothing listens on: bind, read, close. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}

function releaseEmbedded(resolution: QdrantResolution): void {
  if (resolution.mode === "embedded") resolution.release();
}

async function readyzServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.statusCode = req.url === "/readyz" ? 200 : 404;
    res.end(req.url === "/" ? JSON.stringify({ version: "0.0.0" }) : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe("sandboxed client vs the machine Qdrant daemon (hdl65)", () => {
  let appDataPath: string;
  let storagePath: string;
  let paths: DaemonPaths;

  beforeEach(() => {
    appDataPath = mkdtempSync(join(tmpdir(), "qdrant-sandboxed-"));
    storagePath = join(appDataPath, "qdrant");
    mkdirSync(storagePath, { recursive: true });
    vi.stubEnv("QDRANT_EMBEDDED_STORAGE_PATH", storagePath);
    paths = getDaemonPaths(storagePath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(appDataPath, { recursive: true, force: true });
  });

  it("treats an EPERM signal-0 answer as a live daemon", () => {
    denySignalsTo(SANDBOXED_DAEMON_PID);
    recordDaemon(paths, SANDBOXED_DAEMON_PID, 52_507);

    expect(isPidAlive(SANDBOXED_DAEMON_PID)).toBe(true);
    expect(isDaemonAlive(paths)).toBe(true);
  });

  describe("findRecordedDaemon", () => {
    it("vouches by pid when the pid probe says alive, without probing the port", async () => {
      recordDaemon(paths, SANDBOXED_DAEMON_PID, 52_507);
      const portAnswers = vi.fn(async () => false);

      const recorded = await findRecordedDaemon(paths, { isAlive: () => true, portAnswers });

      expect(recorded).toEqual({ pid: SANDBOXED_DAEMON_PID, port: 52_507, attestedBy: "pid" });
      expect(portAnswers).not.toHaveBeenCalled();
    });

    it("vouches by port when the pid is gone but the recorded port still answers", async () => {
      recordDaemon(paths, GONE_DAEMON_PID, 52_507);

      const recorded = await findRecordedDaemon(paths, { isAlive: () => false, portAnswers: async () => true });

      expect(recorded).toEqual({ pid: GONE_DAEMON_PID, port: 52_507, attestedBy: "port" });
    });

    it("finds nothing when the pid is gone and the recorded port is dead", async () => {
      recordDaemon(paths, GONE_DAEMON_PID, 52_507);

      const recorded = await findRecordedDaemon(paths, { isAlive: () => false, portAnswers: async () => false });

      expect(recorded).toBeUndefined();
    });

    it("finds nothing when no port is recorded", async () => {
      writeFileSync(paths.pidFile, String(SANDBOXED_DAEMON_PID), "utf-8");

      const recorded = await findRecordedDaemon(paths, { isAlive: () => true, portAnswers: async () => true });

      expect(recorded).toBeUndefined();
    });
  });

  it("does not evict a stale daemon it is not permitted to signal", async () => {
    recordDaemon(paths, SANDBOXED_DAEMON_PID, 52_507);
    const killPid = vi.fn(() => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    const evicted = await evictStaleDaemon(paths, SANDBOXED_DAEMON_PID, "http://127.0.0.1:52507", undefined, {
      probeVersion: async () => "0.0.1",
      killPid,
      isAlive: () => true,
      sleep: async () => {},
      binaryUpToDate: () => true,
    });

    expect(evicted).toBe(false);
    expect(readFileSync(paths.pidFile, "utf-8")).toBe(String(SANDBOXED_DAEMON_PID));
    expect(readFileSync(paths.portFile, "utf-8")).toBe("52507");
  });

  it("attaches through the port file when the daemon pid cannot be signalled, leaving its files intact", async () => {
    denySignalsTo(SANDBOXED_DAEMON_PID);
    const port = await closedPort(); // still recovering shards: HTTP not bound yet
    recordDaemon(paths, SANDBOXED_DAEMON_PID, port);

    const resolution = await resolveQdrantUrl("embedded", appDataPath);
    releaseEmbedded(resolution);

    expect(resolution).toMatchObject({ mode: "embedded", url: `http://127.0.0.1:${port}`, pid: SANDBOXED_DAEMON_PID });
    expect(readFileSync(paths.pidFile, "utf-8")).toBe(String(SANDBOXED_DAEMON_PID));
    expect(readFileSync(paths.portFile, "utf-8")).toBe(String(port));
  });

  it("attaches without a ref when the sandbox denies writing the refs file, and its release leaves the refs alone", async () => {
    denySignalsTo(SANDBOXED_DAEMON_PID);
    const port = await closedPort();
    recordDaemon(paths, SANDBOXED_DAEMON_PID, port);
    writeFileSync(paths.refsFile, `1\n${SANDBOXED_DAEMON_PID}`, "utf-8");
    chmodSync(paths.refsFile, 0o444); // the sandbox may read the daemon dir, not write it

    try {
      const resolution = await resolveQdrantUrl("embedded", appDataPath);
      expect(resolution).toMatchObject({ mode: "embedded", url: `http://127.0.0.1:${port}` });
      expect(() => {
        releaseEmbedded(resolution);
      }).not.toThrow();
      expect(readFileSync(paths.refsFile, "utf-8")).toBe(`1\n${SANDBOXED_DAEMON_PID}`);
      expect(readFileSync(paths.pidFile, "utf-8")).toBe(String(SANDBOXED_DAEMON_PID));
    } finally {
      chmodSync(paths.refsFile, 0o644);
    }
  });

  it("attaches to a daemon still answering on the recorded port although its recorded pid is gone", async () => {
    const { server, port } = await readyzServer();
    try {
      recordDaemon(paths, GONE_DAEMON_PID, port);

      const resolution = await resolveQdrantUrl("embedded", appDataPath);
      releaseEmbedded(resolution);

      expect(resolution).toMatchObject({ mode: "embedded", url: `http://127.0.0.1:${port}` });
      expect(readFileSync(paths.portFile, "utf-8")).toBe(String(port));
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });

  it("clears the files of a dead daemon whose port is dead before cold-spawning", async () => {
    const port = await closedPort();
    recordDaemon(paths, GONE_DAEMON_PID, port);

    await expect(resolveQdrantUrl("embedded", appDataPath)).rejects.toThrow(/never reach the cold-spawn download/);

    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.portFile)).toBe(false);
  });
});
