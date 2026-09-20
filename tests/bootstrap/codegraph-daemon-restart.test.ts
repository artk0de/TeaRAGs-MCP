/**
 * `restartCodegraphDaemons` — the orchestration behind `tea-rags doctor
 * --restart` (bd tea-rags-mcp-42hno). Two or more live builds on one machine
 * is the normal case the build-keyed daemon creates, so a restart must stop
 * ALL of them (each session's next codegraph op cold-spawns its own build's
 * daemon again) and sweep the key directories of daemons that are already
 * gone. The signal is injectable: tests simulate the daemon's graceful exit
 * by removing its pid file the way the real SIGTERM handler's cleanup does.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { codegraphDaemonStorageDir, restartCodegraphDaemons } from "../../src/bootstrap/codegraph-daemon-restart.js";
import { daemonPathsForKeyDir } from "../../src/core/adapters/duckdb/daemon/lifecycle.js";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

function keyDir(name: string, pid: number | undefined): ReturnType<typeof daemonPathsForKeyDir> {
  const paths = daemonPathsForKeyDir(join(root, name));
  mkdirSync(paths.buildDir, { recursive: true });
  writeFileSync(paths.socketPath, "socket");
  if (pid !== undefined) writeFileSync(paths.pidFile, String(pid));
  return paths;
}

describe("restartCodegraphDaemons (42hno)", () => {
  it("signals every live keyed daemon and reports it stopped once its pid file clears", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-restart-"));
    const live = keyDir("b-aaaaaaaa", process.pid);
    const signal = vi.fn(() => {
      rmSync(live.pidFile);
    }); // the daemon's graceful cleanup

    const outcomes = await restartCodegraphDaemons({
      storageDir: root,
      signal,
      exitTimeoutMs: 2_000,
      pollIntervalMs: 20,
    });

    expect(signal).toHaveBeenCalledWith(process.pid);
    // The stopped daemon's own cleanup emptied its key dir; the follow-up
    // orphan sweep removes the emptied directory with it.
    expect(outcomes).toEqual([
      { keyDir: live.buildDir, pid: process.pid, action: "stopped" },
      { keyDir: live.buildDir, action: "swept" },
    ]);
    expect(existsSync(live.buildDir)).toBe(false);
  });

  it("sweeps orphaned key directories (dead pid or no pid) alongside the stops", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-restart-"));
    keyDir("b-deadbeef", 99999999);
    keyDir("b-00000000", undefined);

    const outcomes = await restartCodegraphDaemons({ storageDir: root });

    expect(outcomes.map((o) => o.action).sort()).toEqual(["swept", "swept"]);
    expect(existsSync(join(root, "b-deadbeef"))).toBe(false);
    expect(existsSync(join(root, "b-00000000"))).toBe(false);
  });

  it("never sweeps the directory of a daemon that missed its exit window", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-restart-"));
    const wedged = keyDir("b-cccccccc", process.pid);

    const outcomes = await restartCodegraphDaemons({
      storageDir: root,
      signal: () => undefined, // the daemon ignores the signal — wedged
      exitTimeoutMs: 150,
      pollIntervalMs: 20,
    });

    expect(outcomes).toEqual([{ keyDir: wedged.buildDir, pid: process.pid, action: "exit-timeout" }]);
    expect(existsSync(wedged.buildDir)).toBe(true);
  });

  it("reports nothing when no build-key directory exists", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-restart-"));
    const outcomes = await restartCodegraphDaemons({ storageDir: root });
    expect(outcomes).toEqual([]);
  });

  it("a signal failure is reported per daemon and never sweeps its directory", async () => {
    root = mkdtempSync(join(tmpdir(), "cg-restart-"));
    const live = keyDir("b-dddddddd", process.pid);

    const outcomes = await restartCodegraphDaemons({
      storageDir: root,
      signal: () => {
        throw new Error("ESRCH");
      },
    });

    expect(outcomes).toEqual([{ keyDir: live.buildDir, pid: process.pid, action: "signal-failed" }]);
    expect(existsSync(live.buildDir)).toBe(true);
  });

  it("codegraphDaemonStorageDir resolves the base dir (env override wins)", () => {
    vi.stubEnv("TEA_RAGS_CODEGRAPH_DAEMON_DIR", "/custom/daemon-dir");
    try {
      expect(codegraphDaemonStorageDir("/app-data")).toBe("/custom/daemon-dir");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(codegraphDaemonStorageDir("/app-data")).toBe(join("/app-data", "codegraph"));
  });
});
