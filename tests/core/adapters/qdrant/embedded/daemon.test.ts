import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildDaemonEnv,
  computeStartupPhase,
  EMBEDDED_MARKER,
  evictStaleDaemon,
  getDaemonPaths,
  gracefulKill,
  isDaemonAlive,
  isPidAlive,
  makeReconnect,
  probeDaemonVersion,
  waitForDaemonReady,
  type EvictStaleDaemonDeps,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";
import { QDRANT_VERSION } from "../../../../../src/core/adapters/qdrant/required-version.js";

describe("EMBEDDED_MARKER", () => {
  it("equals 'embedded'", () => {
    expect(EMBEDDED_MARKER).toBe("embedded");
  });
});

describe("getDaemonPaths", () => {
  it("returns pid, port, refs, lock, startedAt files under storage path", () => {
    const paths = getDaemonPaths("/tmp/test-qdrant");
    expect(paths.pidFile).toBe("/tmp/test-qdrant/daemon.pid");
    expect(paths.portFile).toBe("/tmp/test-qdrant/daemon.port");
    expect(paths.refsFile).toBe("/tmp/test-qdrant/daemon.refs");
    expect(paths.lockFile).toBe("/tmp/test-qdrant/daemon.lock");
    expect(paths.startedAtFile).toBe("/tmp/test-qdrant/daemon.started_at");
    expect(paths.storagePath).toBe("/tmp/test-qdrant");
  });
});

describe("computeStartupPhase", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-phase-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when daemon is not alive", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, "999999999", "utf-8"); // dead pid
    writeFileSync(paths.startedAtFile, String(Date.now()), "utf-8");
    expect(computeStartupPhase(paths)).toBeNull();
  });

  it("returns 'starting' when alive and within the starting window", () => {
    const paths = getDaemonPaths(tempDir);
    const now = Date.now();
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    writeFileSync(paths.startedAtFile, String(now - 5_000), "utf-8"); // 5s ago
    expect(computeStartupPhase(paths, now)).toBe("starting");
  });

  it("returns 'recovering' when alive and past the starting window", () => {
    const paths = getDaemonPaths(tempDir);
    const now = Date.now();
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    writeFileSync(paths.startedAtFile, String(now - 60_000), "utf-8"); // 60s ago
    expect(computeStartupPhase(paths, now)).toBe("recovering");
  });

  it("returns 'recovering' when startedAt file is missing (unknown start time)", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    // no startedAtFile written
    expect(computeStartupPhase(paths)).toBe("recovering");
  });
});

describe("isDaemonAlive", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns false when no pid file exists", () => {
    const paths = getDaemonPaths(tempDir);
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns false when pid file contains invalid pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, "999999999", "utf-8");
    expect(isDaemonAlive(paths)).toBe(false);
  });

  it("returns true for current process pid", () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8");
    expect(isDaemonAlive(paths)).toBe(true);
  });
});

describe("makeReconnect", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-reconnect-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("re-resolves by respawning when the daemon is dead", async () => {
    const paths = getDaemonPaths(tempDir);
    // No pid/port files written — daemon is gone (the rebuild/restart window).
    const respawn = vi.fn().mockResolvedValue("http://127.0.0.1:55555");

    const reconnect = makeReconnect(paths, 11111, respawn);
    const url = await reconnect();

    expect(respawn).toHaveBeenCalledOnce();
    expect(url).toBe("http://127.0.0.1:55555");
  });

  it("returns the new URL without respawning when a live daemon moved ports", async () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8"); // live daemon
    writeFileSync(paths.portFile, "22222", "utf-8"); // moved from 11111
    const respawn = vi.fn();

    const reconnect = makeReconnect(paths, 11111, respawn);
    const url = await reconnect();

    expect(respawn).not.toHaveBeenCalled();
    expect(url).toBe("http://127.0.0.1:22222");
  });

  it("returns null without respawning when a live daemon kept the same port", async () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(process.pid), "utf-8"); // live daemon
    writeFileSync(paths.portFile, "11111", "utf-8"); // unchanged
    const respawn = vi.fn();

    const reconnect = makeReconnect(paths, 11111, respawn);
    const url = await reconnect();

    expect(respawn).not.toHaveBeenCalled();
    expect(url).toBeNull();
  });
});

describe("gracefulKill", () => {
  it("is exported and callable", () => {
    expect(typeof gracefulKill).toBe("function");
  });
});

describe("buildDaemonEnv", () => {
  it("applies multi-core performance defaults", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, {});
    expect(env.QDRANT__STORAGE__PERFORMANCE__MAX_SEARCH_THREADS).toBe("0");
    expect(env.QDRANT__STORAGE__PERFORMANCE__MAX_OPTIMIZATION_THREADS).toBe("0");
    expect(env.QDRANT__STORAGE__PERFORMANCE__OPTIMIZER_CPU_BUDGET).toBe("0");
    expect(env.QDRANT__STORAGE__PERFORMANCE__ASYNC_SCORING_ENABLED).toBe("true");
  });

  it("forces storage path and ports regardless of parent env", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, {
      QDRANT__STORAGE__STORAGE_PATH: "/wrong",
      QDRANT__SERVICE__HTTP_PORT: "9999",
      QDRANT__SERVICE__GRPC_PORT: "9998",
    });
    expect(env.QDRANT__STORAGE__STORAGE_PATH).toBe("/tmp/q");
    expect(env.QDRANT__SERVICE__HTTP_PORT).toBe("6333");
    expect(env.QDRANT__SERVICE__GRPC_PORT).toBe("0");
  });

  it("respects user-provided performance overrides", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, {
      QDRANT__STORAGE__PERFORMANCE__MAX_OPTIMIZATION_THREADS: "4",
      QDRANT__STORAGE__PERFORMANCE__ASYNC_SCORING_ENABLED: "false",
    });
    expect(env.QDRANT__STORAGE__PERFORMANCE__MAX_OPTIMIZATION_THREADS).toBe("4");
    expect(env.QDRANT__STORAGE__PERFORMANCE__ASYNC_SCORING_ENABLED).toBe("false");
    expect(env.QDRANT__STORAGE__PERFORMANCE__MAX_SEARCH_THREADS).toBe("0");
  });

  it("preserves unrelated parent env vars", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, { PATH: "/usr/bin", FOO: "bar" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.FOO).toBe("bar");
  });

  it("low-memory mode sets the single low_memory_mode flag to no_populate", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, {}, true);
    expect(env.QDRANT__STORAGE__LOW_MEMORY_MODE).toBe("no_populate");
  });

  it("normal mode does not set the low_memory_mode flag", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, {}, false);
    expect(env.QDRANT__STORAGE__LOW_MEMORY_MODE).toBeUndefined();
  });

  it("low-memory default yields to a user-provided low_memory_mode override", () => {
    const env = buildDaemonEnv("/tmp/q", 6333, { QDRANT__STORAGE__LOW_MEMORY_MODE: "no_resident" }, true);
    expect(env.QDRANT__STORAGE__LOW_MEMORY_MODE).toBe("no_resident");
  });
});

describe("isPidAlive", () => {
  it("returns true for the current process", () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for a non-existent pid", () => {
    expect(isPidAlive(999_999_999)).toBe(false);
  });
});

describe("waitForDaemonReady", () => {
  it("resolves as soon as the probe returns true", async () => {
    const probe = async () => true;
    await expect(
      waitForDaemonReady(process.pid, "http://unused", { probe, intervalMs: 10, timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
  });

  it("bails immediately when the daemon pid disappears", async () => {
    const probe = async () => false;
    await expect(
      waitForDaemonReady(999_999_999, "http://unused", {
        probe,
        intervalMs: 10,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/exited during startup/);
  });

  it("rejects with a timeout when pid stays alive but probe never succeeds", async () => {
    const probe = async () => false;
    await expect(
      waitForDaemonReady(process.pid, "http://unused", {
        probe,
        intervalMs: 10,
        timeoutMs: 60,
      }),
    ).rejects.toThrow(/did not become ready/);
  });

  it("detects readiness after a few polls", async () => {
    let calls = 0;
    const probe = async () => ++calls >= 3;
    await expect(
      waitForDaemonReady(process.pid, "http://unused", { probe, intervalMs: 10, timeoutMs: 1000 }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });
});

describe("probeDaemonVersion", () => {
  const okResponse = (version: unknown): Response =>
    ({ ok: true, json: async () => ({ version }) }) as unknown as Response;

  it("returns the reported version when the daemon responds with a version string", async () => {
    const fetchImpl = vi.fn(async () => okResponse("1.18.2"));
    await expect(probeDaemonVersion("http://127.0.0.1:6333", fetchImpl)).resolves.toBe("1.18.2");
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:6333/", expect.anything());
  });

  it("returns undefined when the HTTP response is not ok", async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) }) as unknown as Response;
    await expect(probeDaemonVersion("http://127.0.0.1:6333", fetchImpl)).resolves.toBeUndefined();
  });

  it("returns undefined when the body carries no string version", async () => {
    const fetchImpl = async () => okResponse(42);
    await expect(probeDaemonVersion("http://127.0.0.1:6333", fetchImpl)).resolves.toBeUndefined();
  });

  it("returns undefined when the fetch rejects (never throws)", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(probeDaemonVersion("http://127.0.0.1:6333", fetchImpl)).resolves.toBeUndefined();
  });
});

describe("evictStaleDaemon", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "qdrant-evict-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  const URL = "http://127.0.0.1:6333";
  const PID = 4242;

  const makeDeps = (over: Partial<EvictStaleDaemonDeps> = {}): EvictStaleDaemonDeps => ({
    probeVersion: async () => QDRANT_VERSION,
    killPid: vi.fn(),
    isAlive: () => false,
    sleep: vi.fn(async () => {}),
    binaryUpToDate: () => true,
    ...over,
  });

  it("attaches (no eviction) when the running daemon reports the pinned version", async () => {
    const killPid = vi.fn();
    const result = await evictStaleDaemon(
      getDaemonPaths(tempDir),
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => QDRANT_VERSION, killPid }),
    );
    expect(result).toBe(false);
    expect(killPid).not.toHaveBeenCalled();
  });

  it("attaches (no eviction) when the version probe fails (undefined)", async () => {
    const killPid = vi.fn();
    const result = await evictStaleDaemon(
      getDaemonPaths(tempDir),
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => undefined, killPid }),
    );
    expect(result).toBe(false);
    expect(killPid).not.toHaveBeenCalled();
  });

  it("attaches (no eviction) when the running daemon is newer than pinned (no downgrade)", async () => {
    const killPid = vi.fn();
    const result = await evictStaleDaemon(
      getDaemonPaths(tempDir),
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => "99.0.0", killPid }),
    );
    expect(result).toBe(false);
    expect(killPid).not.toHaveBeenCalled();
  });

  it("attaches (no eviction) without probing when the on-disk binary is not up to date", async () => {
    const probeVersion = vi.fn(async () => "0.0.1");
    const killPid = vi.fn();
    const result = await evictStaleDaemon(
      getDaemonPaths(tempDir),
      PID,
      URL,
      undefined,
      makeDeps({ binaryUpToDate: () => false, probeVersion, killPid }),
    );
    expect(result).toBe(false);
    expect(probeVersion).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });

  it("restarts (SIGTERM + wait-for-exit + cleanup) when binary is current but the daemon is stale", async () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(PID), "utf-8");
    writeFileSync(paths.portFile, "6333", "utf-8");
    writeFileSync(paths.refsFile, "2", "utf-8");

    const killPid = vi.fn();
    let aliveCalls = 0;
    const isAlive = vi.fn(() => {
      aliveCalls += 1;
      return aliveCalls <= 2; // alive twice, then exits
    });
    const sleep = vi.fn(async () => {});

    const result = await evictStaleDaemon(
      paths,
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => "0.0.1", killPid, isAlive, sleep }),
    );

    expect(result).toBe(true);
    expect(killPid).toHaveBeenCalledWith(PID, "SIGTERM");
    expect(sleep).toHaveBeenCalled(); // waited for the old process to exit
    expect(existsSync(paths.pidFile)).toBe(false);
    expect(existsSync(paths.portFile)).toBe(false);
    expect(existsSync(paths.refsFile)).toBe(false);
  });

  it("still evicts (cleanup, no wait) when SIGTERM throws because the process is already dead", async () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(PID), "utf-8");

    const killPid = vi.fn(() => {
      throw new Error("ESRCH");
    });
    const sleep = vi.fn(async () => {});

    const result = await evictStaleDaemon(
      paths,
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => "0.0.1", killPid, sleep }),
    );

    expect(result).toBe(true);
    expect(killPid).toHaveBeenCalledWith(PID, "SIGTERM");
    expect(sleep).not.toHaveBeenCalled();
    expect(existsSync(paths.pidFile)).toBe(false);
  });

  it("escalates to SIGKILL when the stale daemon ignores SIGTERM", async () => {
    const paths = getDaemonPaths(tempDir);
    writeFileSync(paths.pidFile, String(PID), "utf-8");

    let killed = false;
    const killPid = vi.fn((_pid: number, signal: NodeJS.Signals) => {
      if (signal === "SIGKILL") killed = true;
    });
    const isAlive = () => !killed; // stays alive until SIGKILL lands

    const result = await evictStaleDaemon(
      paths,
      PID,
      URL,
      undefined,
      makeDeps({ probeVersion: async () => "0.0.1", killPid, isAlive }),
    );

    expect(result).toBe(true);
    expect(killPid).toHaveBeenCalledWith(PID, "SIGTERM");
    expect(killPid).toHaveBeenCalledWith(PID, "SIGKILL");
  });
});
