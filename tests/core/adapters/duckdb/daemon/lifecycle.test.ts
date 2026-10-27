import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DAEMON_LOG_MAX_BYTES,
  decrementRefs,
  getDaemonPaths,
  getStorageDir,
  IDLE_SHUTDOWN_MS,
  incrementRefs,
  openDaemonLogFd,
  readRefs,
  scheduleIdleWatcher,
} from "../../../../../src/core/adapters/duckdb/daemon/lifecycle.js";

let dir: string;

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((resolve) =>
    child.once("exit", () => {
      resolve();
    }),
  );
  return child.pid as number;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("codegraph daemon lifecycle refcount", () => {
  it("paths include socket + pid + refs + lock under the storage dir", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(p.socketPath.endsWith("codegraph-daemon.sock")).toBe(true);
    expect(p.refsFile.endsWith("codegraph-daemon.refs")).toBe(true);
    expect(p.lockFile.endsWith("codegraph-daemon.lock")).toBe(true);
  });

  it("paths include the log the spawned daemon writes its output to", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    // Keyed layout (bd tea-rags-mcp-42hno): the log lives in the per-build key
    // dir, next to the socket it belongs to.
    expect(p.logFile).toBe(join(p.buildDir, "codegraph-daemon.log"));
  });

  it("openDaemonLogFd appends, so an earlier spawn's crash survives the next one", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    mkdirSync(p.buildDir, { recursive: true });
    writeFileSync(p.logFile, "first spawn died\n", "utf-8");

    const fd = openDaemonLogFd(p);
    closeSync(fd);

    expect(readFileSync(p.logFile, "utf-8")).toContain("first spawn died");
  });

  it("openDaemonLogFd truncates a log that grew past the size cap", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    mkdirSync(p.buildDir, { recursive: true });
    writeFileSync(p.logFile, "x".repeat(DAEMON_LOG_MAX_BYTES + 1), "utf-8");

    const fd = openDaemonLogFd(p);
    closeSync(fd);

    expect(statSync(p.logFile).size).toBe(0);
  });

  it("increment/decrement refs are symmetric and floored at 0", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    expect(incrementRefs(p)).toBe(1);
    expect(incrementRefs(p)).toBe(2);
    expect(decrementRefs(p)).toBe(1);
    expect(decrementRefs(p)).toBe(0);
    expect(decrementRefs(p)).toBe(0); // floored
    expect(readRefs(p)).toBe(0);
  });

  it("keeps the live count on the first line, so an integer reader agrees", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    incrementRefs(p);
    incrementRefs(p);
    expect(parseInt(readFileSync(p.refsFile, "utf-8"), 10)).toBe(2);
    expect(readFileSync(p.refsFile, "utf-8").split("\n").slice(1)).toEqual([String(process.pid), String(process.pid)]);
  });

  it("getStorageDir honors the env override, else nests codegraph/ under app data", () => {
    const prev = process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR;
    delete process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR;
    try {
      expect(getStorageDir("/data/app")).toBe(join("/data/app", "codegraph"));
      process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR = "/override/dir";
      expect(getStorageDir("/data/app")).toBe("/override/dir");
    } finally {
      if (prev === undefined) delete process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR;
      else process.env.TEA_RAGS_CODEGRAPH_DAEMON_DIR = prev;
    }
  });
});

describe("scheduleIdleWatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invokes onShutdown once refs stay at 0 for the idle window", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    vi.useFakeTimers();
    const onShutdown = vi.fn();
    scheduleIdleWatcher(p, onShutdown);

    // refs start at 0 → after the first poll idleSince is set, after the
    // idle window elapses onShutdown fires exactly once.
    vi.advanceTimersByTime(5_000); // first poll: marks idleSince
    expect(onShutdown).not.toHaveBeenCalled();
    vi.advanceTimersByTime(IDLE_SHUTDOWN_MS); // window elapses
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("does not shut down while a client holds a ref, then resets the idle clock", () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    incrementRefs(p); // one live client
    vi.useFakeTimers();
    const onShutdown = vi.fn();
    scheduleIdleWatcher(p, onShutdown);

    vi.advanceTimersByTime(5_000 + IDLE_SHUTDOWN_MS);
    expect(onShutdown).not.toHaveBeenCalled(); // ref held → never idle

    // Client disconnects → idle clock starts now, fires after the window.
    decrementRefs(p);
    vi.advanceTimersByTime(5_000); // marks idleSince
    vi.advanceTimersByTime(IDLE_SHUTDOWN_MS);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it("shuts down when the only refs belong to a daemon that has exited", async () => {
    dir = mkdtempSync(join(tmpdir(), "cgl-"));
    const p = getDaemonPaths(dir);
    const crashed = await deadPid();
    mkdirSync(p.buildDir, { recursive: true });
    writeFileSync(p.refsFile, `2\n${crashed}\n${crashed}`, "utf-8");
    expect(readRefs(p)).toBe(0);
    vi.useFakeTimers();
    const onShutdown = vi.fn();
    scheduleIdleWatcher(p, onShutdown);

    vi.advanceTimersByTime(5_000 + IDLE_SHUTDOWN_MS);
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });
});
