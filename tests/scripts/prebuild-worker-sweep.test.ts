/**
 * The `npm run build` pre-step (bd tea-rags-mcp-f924y).
 *
 * A rebuild rewrites `build/` under every process running from it. An orphaned
 * index worker from THIS checkout is dead weight either way and is stopped; a
 * live one is reported, because the rebuild swaps the code its next worker
 * thread or chunker child will load. Nothing outside this checkout's build is
 * looked at — other worktrees and the machine-wide daemons belong to other
 * sessions — and nothing here may ever fail the build.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { prebuildWorkerSweep } from "../../scripts/prebuild-worker-sweep.js";
import { IndexWorkerRegistry, type IndexWorkerRecord } from "../../src/cli/index-progress/worker-registry.js";
import type { IndexWorkerProcessProbe, IndexWorkerProcessSnapshot } from "../../src/cli/index-progress/worker-sweep.js";

const NOW = 50_000_000;

describe("prebuildWorkerSweep (f924y)", () => {
  let dir: string;
  let repoRoot: string;
  let registry: IndexWorkerRegistry;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prebuild-worker-sweep-"));
    repoRoot = join(dir, "checkout");
    mkdirSync(join(repoRoot, "build", "cli"), { recursive: true });
    repoRoot = realpathSync(repoRoot);
    registry = new IndexWorkerRegistry(join(dir, "workers"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function worker(pid: number, entryScript: string, extra: Partial<IndexWorkerRecord> = {}): IndexWorkerRecord {
    const record = {
      pid,
      supervisorPid: pid - 1,
      startedAtMs: NOW - 1_000,
      entryScript,
      projectPath: `/repo-${pid}`,
      lastProgressAtMs: NOW - 1_000,
      ...extra,
    };
    registry.register(record);
    return record;
  }

  function orphanedSnapshot(record: IndexWorkerRecord): IndexWorkerProcessSnapshot {
    return {
      ppid: 1,
      pgid: record.pid,
      startedAtMs: record.startedAtMs,
      command: `node ${record.entryScript} index-codebase --__worker`,
    };
  }

  it("stops this checkout's orphaned workers, reports its live ones, and leaves other checkouts alone", async () => {
    const ownOrphan = worker(11, join(repoRoot, "build", "cli", "index.js"));
    const ownLive = worker(21, join(repoRoot, "build", "cli", "index.js"));
    const foreignOrphan = worker(31, "/elsewhere/build/cli/index.js");
    const table = new Map<number, IndexWorkerProcessSnapshot>([
      [ownOrphan.pid, orphanedSnapshot(ownOrphan)],
      [ownLive.pid, { ...orphanedSnapshot(ownLive), ppid: ownLive.supervisorPid }],
      [foreignOrphan.pid, orphanedSnapshot(foreignOrphan)],
    ]);
    const killed: number[] = [];
    const probe: IndexWorkerProcessProbe = {
      inspect: (pid) => table.get(pid),
      kill: (target) => {
        killed.push(target);
        table.delete(Math.abs(target));
      },
    };
    const lines: string[] = [];

    await prebuildWorkerSweep({ repoRoot, registry, probe, now: () => NOW, log: (line) => lines.push(line) });

    expect(killed).toEqual([-11]);
    expect(lines.join("\n")).toMatch(/stopped orphaned index worker 11/);
    expect(lines.join("\n")).toMatch(/index worker 21 .*still running/);
    expect(lines.join("\n")).not.toMatch(/\b31\b/);
    expect(
      registry
        .list()
        .map((r) => r.pid)
        .sort(),
    ).toEqual([21, 31]);
  });

  it("says nothing when this checkout has no workers", async () => {
    const lines: string[] = [];
    const probe: IndexWorkerProcessProbe = { inspect: () => undefined, kill: () => undefined };

    await prebuildWorkerSweep({ repoRoot, registry, probe, now: () => NOW, log: (line) => lines.push(line) });

    expect(lines).toEqual([]);
  });

  it("never fails the build over a sweep that could not run", async () => {
    worker(11, join(repoRoot, "build", "cli", "index.js"));
    const lines: string[] = [];
    const probe: IndexWorkerProcessProbe = {
      inspect: () => {
        throw new Error("ps exploded");
      },
      kill: () => undefined,
    };

    await expect(
      prebuildWorkerSweep({ repoRoot, registry, probe, now: () => NOW, log: (line) => lines.push(line) }),
    ).resolves.toBeUndefined();
    expect(lines.join("\n")).toMatch(/worker sweep skipped: ps exploded/);
  });
});
