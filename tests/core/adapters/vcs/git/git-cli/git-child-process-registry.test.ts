/**
 * Git child-process reaping on the in-process (MCP server) path
 * (bd tea-rags-mcp-w26dc).
 *
 * MCP `index_codebase` runs `App#indexCodebase` inside the server process and
 * the git trajectory is dispatched inline (no workerDescriptor), so every git
 * spawn is a direct child of the MCP server — the CLI worker's parent-death
 * guard never applies there. The registry is what lets the server's shutdown
 * path find and kill the git children a mid-flight enrichment left running.
 *
 * Real processes throughout: a fake `git` on PATH that records its pid and then
 * sleeps stands in for a git that is still computing (blame, a giant-commit
 * `log --numstat`) when the server is told to stop.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createCatFileBatch,
  createCatFileBatchCheck,
  execFileForPathspec,
  getHead,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import {
  reapGitChildProcesses,
  trackGitChildProcess,
} from "../../../../../../src/core/adapters/vcs/git/git-cli/git-child-process-registry.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("git child-process registry", () => {
  const spawnedPids: number[] = [];

  afterEach(() => {
    // Only processes this test started — never anything by name.
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  it("kills a tracked child that is still running and reports how many it reaped", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid as number;
    spawnedPids.push(pid);
    // The exit event, not a pid probe: a SIGKILLed child stays a zombie (and
    // answers kill(pid, 0)) until libuv reaps it.
    const exited = once(child, "exit");
    trackGitChildProcess(child);
    expect(isAlive(pid)).toBe(true);

    expect(reapGitChildProcesses()).toBe(1);

    const [, signal] = (await exited) as [number | null, NodeJS.Signals | null];
    expect(signal).toBe("SIGKILL");
  });

  it("forgets a child once it has exited, so a finished spawn is never signalled", async () => {
    const child = spawn("true", [], { stdio: "ignore" });
    trackGitChildProcess(child);
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });

    expect(reapGitChildProcesses()).toBe(0);
  });
});

describe("git-cli client spawns are reapable (fake git on PATH)", () => {
  const dir = mkdtempSync(join(tmpdir(), "git-reap-"));
  const pidFile = join(dir, "git.pid");
  const originalPath = process.env.PATH;

  beforeAll(() => {
    // `exec` keeps the pid, so the recorded pid IS the process the client spawned.
    writeFileSync(join(dir, "git"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, "utf8");
    chmodSync(join(dir, "git"), 0o755);
    process.env.PATH = `${dir}:${originalPath ?? ""}`;
  });

  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8").trim()), "SIGKILL");
    } catch {
      /* already gone, or never started */
    }
    rmSync(pidFile, { force: true });
  });

  async function fakeGitPid(): Promise<number> {
    return vi.waitFor(
      () => {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        expect(pid).toBeGreaterThan(0);
        return pid;
      },
      { timeout: 20_000, interval: 25 },
    );
  }

  /**
   * Reap, then wait for the pending call to fail. Every client path settles
   * from the child's exit/close, by which point libuv has reaped the pid — so
   * the liveness probe after it cannot see a zombie.
   */
  async function expectReaped(pid: number, settled: Promise<unknown>): Promise<void> {
    expect(reapGitChildProcesses()).toBeGreaterThanOrEqual(1);
    expect(await settled).toBeInstanceOf(Error);
    expect(isAlive(pid)).toBe(false);
  }

  it("reaps an execFile spawn (getHead) and fails the pending call", async () => {
    const settled = getHead(dir).catch((err: unknown) => err);
    const pid = await fakeGitPid();

    await expectReaped(pid, settled);
  });

  it("reaps a stall-guarded streaming spawn (execFileForPathspec)", async () => {
    const settled = execFileForPathspec(dir, ["log", "HEAD"], 60_000).catch((err: unknown) => err);
    const pid = await fakeGitPid();

    await expectReaped(pid, settled);
  });

  it("reaps the long-lived cat-file --batch process", async () => {
    const reader = createCatFileBatch(dir);
    const settled = reader.read("HEAD", "a.ts").catch((err: unknown) => err);
    const pid = await fakeGitPid();

    await expectReaped(pid, settled);
    await reader.close();
  });

  it("reaps the long-lived cat-file --batch-check process", async () => {
    const reader = createCatFileBatchCheck(dir);
    const settled = reader.check("HEAD:a.ts").catch((err: unknown) => err);
    const pid = await fakeGitPid();

    await expectReaped(pid, settled);
    await reader.close();
  });
});
