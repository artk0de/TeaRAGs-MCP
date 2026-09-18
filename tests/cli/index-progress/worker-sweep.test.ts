/**
 * Sweeping orphaned index workers (bd tea-rags-mcp-f924y).
 *
 * A worker the parent-death guard did not catch — its supervisor gone, never
 * handed off — keeps running and keeps its collection's indexing lock alive. The
 * sweep may only ever stop a process it can PROVE is such a worker: registered
 * by the worker itself, still the same process (command line and start time),
 * and parent gone. Everything is exercised against real processes this test
 * spawns; the fake workers carry the `index-codebase --__worker` argv a real one
 * shows in `ps`.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexWorkerRegistry, type IndexWorkerRecord } from "../../../src/cli/index-progress/worker-registry.js";
import {
  INDEX_WORKER_STALLED_AFTER_MS,
  psIndexWorkerProcessProbe,
  sweepIndexWorkers,
} from "../../../src/cli/index-progress/worker-sweep.js";

const WORKER_ARGV = ["-e", "setInterval(() => {}, 1000)", "index-codebase", "--__worker"];
const ENTRY = "/checkout-a/build/cli/index.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

describe("sweepIndexWorkers against real processes (f924y)", () => {
  let dir: string;
  let registry: IndexWorkerRegistry;
  const spawnedPids: number[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "index-worker-sweep-"));
    registry = new IndexWorkerRegistry(join(dir, "workers"));
  });

  afterEach(() => {
    // Only processes this test started — never anything by name.
    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });

  /** A worker whose supervisor started it detached and then died — reparented, own group. */
  function spawnOrphanedWorker(): { pid: number; supervisorPid: number; startedAtMs: number } {
    const startedAtMs = Date.now();
    const supervisor = spawnSync(
      process.execPath,
      [
        "-e",
        `const c = require("node:child_process").spawn(process.execPath, ${JSON.stringify(WORKER_ARGV)}, ` +
          `{ detached: true, stdio: "ignore" }); c.unref(); process.stdout.write(String(c.pid));`,
      ],
      { encoding: "utf8" },
    );
    const pid = Number(supervisor.stdout);
    spawnedPids.push(pid);
    return { pid, supervisorPid: supervisor.pid ?? -1, startedAtMs };
  }

  /** A worker whose supervisor — this test process — is alive. */
  function spawnAttachedWorker(): { pid: number; supervisorPid: number; startedAtMs: number } {
    const startedAtMs = Date.now();
    const child = spawn(process.execPath, WORKER_ARGV, { detached: true, stdio: "ignore" });
    const pid = child.pid ?? -1;
    spawnedPids.push(pid);
    return { pid, supervisorPid: process.pid, startedAtMs };
  }

  function register(
    worker: { pid: number; supervisorPid: number; startedAtMs: number },
    extra: Partial<IndexWorkerRecord> = {},
  ) {
    registry.register({
      ...worker,
      entryScript: ENTRY,
      projectPath: "/repo",
      lastProgressAtMs: Date.now(),
      ...extra,
    });
  }

  it("stops a worker whose supervisor died before handing it off, and forgets it", async () => {
    const orphan = spawnOrphanedWorker();
    register(orphan);

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe, { killGraceMs: 5_000 });

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "orphaned", action: "killed" })]);
    expect(isAlive(orphan.pid)).toBe(false);
    expect(registry.list()).toEqual([]);
  }, 30_000);

  it("leaves a worker whose supervisor is alive running", async () => {
    const attached = spawnAttachedWorker();
    register(attached);

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe);

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "attached", action: "kept" })]);
    expect(isAlive(attached.pid)).toBe(true);
  }, 30_000);

  it("leaves a handed-off worker that is still making progress running", async () => {
    const detached = spawnOrphanedWorker();
    register(detached, { handedOffAtMs: Date.now(), lastProgressAtMs: Date.now() });

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe);

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "detached", action: "kept" })]);
    expect(isAlive(detached.pid)).toBe(true);
  }, 30_000);

  it("reports a handed-off worker that stopped making progress, and stops it only when asked", async () => {
    const stalled = spawnOrphanedWorker();
    const longAgo = Date.now() - INDEX_WORKER_STALLED_AFTER_MS - 60_000;
    register(stalled, { handedOffAtMs: longAgo, lastProgressAtMs: longAgo });

    const reported = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe);
    expect(reported).toEqual([expect.objectContaining({ verdict: "stalled", action: "kept" })]);
    expect(isAlive(stalled.pid)).toBe(true);

    const swept = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe, {
      killStalled: true,
      killGraceMs: 5_000,
    });
    expect(swept).toEqual([expect.objectContaining({ verdict: "stalled", action: "killed" })]);
    expect(isAlive(stalled.pid)).toBe(false);
  }, 30_000);

  it("forgets a record whose pid now belongs to a process that is not a worker — without touching it", async () => {
    const unrelated = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    const pid = unrelated.pid ?? -1;
    spawnedPids.push(pid);
    // Registered as if a worker had run under this pid and its supervisor were gone.
    register({ pid, supervisorPid: 1, startedAtMs: Date.now() });

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe, { killGraceMs: 5_000 });

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "gone", action: "pruned" })]);
    expect(isAlive(pid)).toBe(true);
    expect(registry.list()).toEqual([]);
  }, 30_000);

  it("forgets a record whose worker already exited", async () => {
    const exited = spawnSync(process.execPath, ["-e", "0"]);
    register({ pid: exited.pid ?? -1, supervisorPid: 1, startedAtMs: Date.now() });

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe);

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "gone", action: "pruned" })]);
    expect(registry.list()).toEqual([]);
  }, 30_000);

  it("only reports what a dry run would stop", async () => {
    const orphan = spawnOrphanedWorker();
    register(orphan);

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe, { dryRun: true });

    expect(outcomes).toEqual([expect.objectContaining({ verdict: "orphaned", action: "would-kill" })]);
    expect(isAlive(orphan.pid)).toBe(true);
    expect(registry.list()).toHaveLength(1);
  }, 30_000);

  it("scoped to one checkout's build, leaves every other build's workers out", async () => {
    const orphan = spawnOrphanedWorker();
    register(orphan, { entryScript: "/checkout-b/build/cli/index.js" });

    const outcomes = await sweepIndexWorkers(registry, psIndexWorkerProcessProbe, {
      entryScriptPrefix: "/checkout-a/build/",
      killGraceMs: 5_000,
    });

    expect(outcomes).toEqual([]);
    expect(isAlive(orphan.pid)).toBe(true);
    expect(registry.list()).toHaveLength(1);
  }, 30_000);
});
