/**
 * `tea-rags doctor --sweep-workers` (bd tea-rags-mcp-f924y).
 *
 * What the sweep may stop, and how it proves a pid is a worker, is pinned
 * against real processes in `tests/cli/index-progress/worker-sweep.test.ts`.
 * Here the probe is a stand-in, so the command's own contract is what is under
 * test: which flags reach the sweep, and what the operator — or an agent reading
 * `--json` — is told about each worker.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { doctorCommand, runWorkerSweepDoctor } from "../../../src/cli/commands/doctor.js";
import { IndexWorkerRegistry, type IndexWorkerRecord } from "../../../src/cli/index-progress/worker-registry.js";
import {
  INDEX_WORKER_STALLED_AFTER_MS,
  type IndexWorkerProcessProbe,
  type IndexWorkerProcessSnapshot,
} from "../../../src/cli/index-progress/worker-sweep.js";

const NOW = 10_000_000;

/** A process table the test owns: killing a pid removes it. */
function fakeProcessTable(snapshots: Record<number, IndexWorkerProcessSnapshot>) {
  const table = new Map(Object.entries(snapshots).map(([pid, s]) => [Number(pid), s]));
  const killed: number[] = [];
  const probe: IndexWorkerProcessProbe = {
    inspect: (pid) => table.get(pid),
    kill: (target) => {
      killed.push(target);
      table.delete(Math.abs(target));
    },
  };
  return { probe, killed };
}

function workerSnapshot(ppid: number, startedAtMs: number, pid: number): IndexWorkerProcessSnapshot {
  return { ppid, pgid: pid, startedAtMs, command: "node /checkout/build/cli/index.js index-codebase --__worker" };
}

describe("runWorkerSweepDoctor (f924y)", () => {
  let dir: string;
  let registry: IndexWorkerRegistry;
  let out: string;

  const orphan: IndexWorkerRecord = {
    pid: 101,
    supervisorPid: 100,
    startedAtMs: NOW - 60_000,
    entryScript: "/checkout/build/cli/index.js",
    projectPath: "/repo-orphan",
    lastProgressAtMs: NOW - 60_000,
  };
  const stalled: IndexWorkerRecord = {
    pid: 201,
    supervisorPid: 200,
    startedAtMs: NOW - 2 * INDEX_WORKER_STALLED_AFTER_MS,
    entryScript: "/checkout/build/cli/index.js",
    projectPath: "/repo-stalled",
    handedOffAtMs: NOW - 2 * INDEX_WORKER_STALLED_AFTER_MS,
    lastProgressAtMs: NOW - 2 * INDEX_WORKER_STALLED_AFTER_MS,
  };
  const exited: IndexWorkerRecord = { ...orphan, pid: 301, projectPath: "/repo-exited" };

  function processTable() {
    return fakeProcessTable({
      101: workerSnapshot(1, orphan.startedAtMs, 101),
      201: workerSnapshot(1, stalled.startedAtMs, 201),
    });
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "doctor-sweep-workers-"));
    registry = new IndexWorkerRegistry(join(dir, "workers"));
    for (const record of [orphan, stalled, exited]) registry.register(record);
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops the orphan, warns about the stalled worker, and drops the stale record", async () => {
    const { probe, killed } = processTable();

    await runWorkerSweepDoctor({}, { registry, probe, now: () => NOW, platform: "darwin" });

    expect(killed).toEqual([-101]);
    expect(out).toMatch(/\[KILL\] pid 101 orphaned .*\/repo-orphan/);
    expect(out).toMatch(/\[WARN\] pid 201 stalled .*--include-stalled/);
    expect(out).toMatch(/pid 301 gone/);
    expect(registry.list().map((r) => r.pid)).toEqual([201]);
  });

  it("warns about a worker whose start time could not be read, and keeps it and its record", async () => {
    const { probe, killed } = fakeProcessTable({ 101: { ...workerSnapshot(1, 0, 101), startedAtMs: undefined } });

    await runWorkerSweepDoctor({}, { registry, probe, now: () => NOW, platform: "darwin" });

    expect(killed).toEqual([]);
    expect(out).toMatch(/\[WARN\] pid 101 unverified — its start time could not be read.*\/repo-orphan/);
    expect(registry.list().map((r) => r.pid)).toContain(101);
  });

  it("stops the stalled worker too with --include-stalled", async () => {
    const { probe, killed } = processTable();

    await runWorkerSweepDoctor({ includeStalled: true }, { registry, probe, now: () => NOW, platform: "darwin" });

    expect(killed.sort((a, b) => a - b)).toEqual([-201, -101]);
    expect(out).toMatch(/\[KILL\] pid 201 stalled/);
  });

  it("stops nothing and forgets nothing on --dry-run", async () => {
    const { probe, killed } = processTable();

    await runWorkerSweepDoctor({ dryRun: true }, { registry, probe, now: () => NOW, platform: "darwin" });

    expect(killed).toEqual([]);
    expect(out).toMatch(/pid 101 orphaned .*would be stopped/);
    expect(out).toMatch(/pid 301 gone .*would be removed/);
    expect(registry.list()).toHaveLength(3);
  });

  it("emits one structured entry per worker with --json", async () => {
    const { probe } = processTable();

    await runWorkerSweepDoctor({ json: true }, { registry, probe, now: () => NOW, platform: "darwin" });

    const report = JSON.parse(out) as { workers: { pid: number; verdict: string; action: string }[] };
    expect(report.workers.sort((a, b) => a.pid - b.pid)).toEqual([
      expect.objectContaining({ pid: 101, verdict: "orphaned", action: "killed", projectPath: "/repo-orphan" }),
      expect.objectContaining({ pid: 201, verdict: "stalled", action: "kept" }),
      expect.objectContaining({ pid: 301, verdict: "gone", action: "pruned" }),
    ]);
  });

  it("refuses on Windows, where there is no ps to prove a pid is a worker", async () => {
    const { probe, killed } = processTable();

    await runWorkerSweepDoctor({}, { registry, probe, now: () => NOW, platform: "win32" });

    expect(killed).toEqual([]);
    expect(out).toMatch(/not supported on win32/);
    expect(registry.list()).toHaveLength(3);
  });
});

describe("doctor --sweep-workers routing (f924y)", () => {
  let dataDir: string;
  let out: string;
  const originalDataDir = process.env.TEA_RAGS_DATA_DIR;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "doctor-sweep-route-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    out = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDataDir !== undefined) process.env.TEA_RAGS_DATA_DIR = originalDataDir;
    else delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("sweeps the data directory's worker registry without touching Qdrant or embeddings", async () => {
    await doctorCommand.handler({
      "sweep-workers": true,
      json: false,
      _: [],
      $0: "tea-rags",
    });

    expect(out).toMatch(/No index workers registered/);
  });
});
