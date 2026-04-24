import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildDaemonEnv,
  computeStartupPhase,
  EMBEDDED_MARKER,
  getDaemonPaths,
  gracefulKill,
  isDaemonAlive,
  isPidAlive,
  waitForDaemonReady,
} from "../../../../../src/core/adapters/qdrant/embedded/daemon.js";

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
