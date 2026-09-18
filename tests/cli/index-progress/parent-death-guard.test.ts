/**
 * An index worker whose supervisor died without handing it off reaps itself
 * (bd tea-rags-mcp-f924y).
 *
 * The worker is forked detached — its own process group — so killing the
 * foreground CLI never reaches it or the git / chunker children it started.
 * Left alone it keeps running and keeps its collection's indexing lock alive.
 * The supervisor grants "outlive" before a clean background hand-off; a
 * disconnect WITHOUT that grant means the supervisor died, and the worker takes
 * its whole group down.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it, vi } from "vitest";

import { installParentDeathGuard } from "../../../src/cli/index-progress/parent-death-guard.js";

/** An IPC end that starts connected and can be disconnected or messaged. */
function fakeChannel(connected = true) {
  return Object.assign(new EventEmitter(), { connected });
}

describe("installParentDeathGuard (f924y)", () => {
  it("reports the worker orphaned when the supervisor disconnects without granting outlive", () => {
    const channel = fakeChannel();
    const onOrphaned = vi.fn();
    installParentDeathGuard(channel, { onOrphaned });

    channel.connected = false;
    channel.emit("disconnect");

    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("lets a worker the supervisor handed off outlive the disconnect", () => {
    const channel = fakeChannel();
    const onOrphaned = vi.fn();
    const onOutlive = vi.fn();
    installParentDeathGuard(channel, { onOrphaned, onOutlive });

    channel.emit("message", { type: "outlive" });
    channel.connected = false;
    channel.emit("disconnect");

    expect(onOutlive).toHaveBeenCalledTimes(1);
    expect(onOrphaned).not.toHaveBeenCalled();
  });

  it("reports the worker orphaned when the supervisor was already gone before the guard was installed", () => {
    // The disconnect event fired while nothing listened — the supervisor died
    // during the worker's startup, before `main` got as far as the guard.
    const channel = fakeChannel(false);
    const onOrphaned = vi.fn();

    installParentDeathGuard(channel, { onOrphaned });

    expect(onOrphaned).toHaveBeenCalledTimes(1);
  });

  it("ignores a process that never had an IPC channel", () => {
    const standalone = new EventEmitter() as EventEmitter & { connected?: boolean };
    const onOrphaned = vi.fn();

    installParentDeathGuard(standalone, { onOrphaned });

    expect(onOrphaned).not.toHaveBeenCalled();
  });
});

const SUPERVISOR_SCRIPT = join(import.meta.dirname, "__fixtures__", "orphan-worker-supervisor.ts");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("installParentDeathGuard — a killed foreground CLI across real processes (f924y)", () => {
  const spawnedPids: number[] = [];
  let supervisor: ChildProcessWithoutNullStreams | undefined;

  afterEach(() => {
    supervisor?.kill("SIGKILL");
    supervisor = undefined;
    // Only processes this test started — never anything by name.
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  async function startSupervisedWorker(
    mode: "guarded" | "after-parent",
  ): Promise<{ worker: number; grandchild: number }> {
    const child = spawn(process.execPath, ["--import", "tsx", SUPERVISOR_SCRIPT, mode], {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    supervisor = child;
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const pids: { worker?: number; grandchild?: number } = {};
    while (pids.worker === undefined || pids.grandchild === undefined) {
      const line = (await lines.next()).value as string | undefined;
      if (line === undefined) throw new Error("supervisor exited before reporting its worker");
      Object.assign(pids, JSON.parse(line) as typeof pids);
      if (pids.worker !== undefined && !spawnedPids.includes(pids.worker)) spawnedPids.push(pids.worker);
      if (pids.grandchild !== undefined && !spawnedPids.includes(pids.grandchild)) spawnedPids.push(pids.grandchild);
    }
    return { worker: pids.worker, grandchild: pids.grandchild };
  }

  it("takes the worker and its children down when the supervisor is SIGKILLed", async () => {
    const { worker, grandchild } = await startSupervisedWorker("guarded");
    expect(isAlive(worker)).toBe(true);

    supervisor?.kill("SIGKILL");

    await vi.waitFor(
      () => {
        expect(isAlive(worker)).toBe(false);
        expect(isAlive(grandchild)).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 60_000);

  it("takes them down when the supervisor died before the worker installed its guard", async () => {
    const { worker, grandchild } = await startSupervisedWorker("after-parent");
    expect(isAlive(worker)).toBe(true);

    supervisor?.kill("SIGKILL");

    await vi.waitFor(
      () => {
        expect(isAlive(worker)).toBe(false);
        expect(isAlive(grandchild)).toBe(false);
      },
      { timeout: 15_000, interval: 100 },
    );
  }, 60_000);
});
