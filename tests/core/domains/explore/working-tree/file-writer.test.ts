/**
 * `WorkingTreeFileWriter` (bd tea-rags-mcp-xi2r9, B1): the temp-then-rename
 * write every working-tree store goes through, and the reaping of temps a dead
 * writer left. Live: 8 of 20 cold `tea-rags call` runs left a
 * `<sha>.meta.json.<pid>.<hex>.tmp` behind — a `lastReadAt` bump still in
 * flight when the CLI called `process.exit`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWorkingTreeFileWriter,
  reapAbandonedWorkingTreeTemps,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const HOUR = 3_600_000;

/** A pid that existed and is gone: a child that ran to completion. */
function deadPid(): number {
  const { pid } = spawnSync(process.execPath, ["-e", ""]);
  if (pid === undefined) throw new Error("spawnSync gave no pid");
  return pid;
}

describe("WorkingTreeFileWriter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-file-writer-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lands the content under the target and leaves nothing else", async () => {
    const writer = createWorkingTreeFileWriter();
    const target = join(dir, "a.meta.json");

    await writer.write(target, '{"a":1}');

    expect(readFileSync(target, "utf8")).toBe('{"a":1}');
    expect(readdirSync(dir)).toEqual(["a.meta.json"]);
  });

  it("removes its temp when the write fails, and rejects", async () => {
    const writer = createWorkingTreeFileWriter();
    // A non-empty directory under the target name: the rename cannot replace it.
    const target = join(dir, "taken.meta.json");
    mkdirSync(join(target, "inside"), { recursive: true });

    await expect(writer.write(target, "{}")).rejects.toThrow();

    expect(readdirSync(dir)).toEqual(["taken.meta.json"]);
  });

  it("close waits for the writes in flight and refuses every later one", async () => {
    const writer = createWorkingTreeFileWriter();
    const inFlight = join(dir, "in-flight.meta.json");
    const late = join(dir, "late.meta.json");

    const pending = writer.write(inFlight, "x".repeat(4 * 1024 * 1024));
    await writer.close();

    expect(readFileSync(inFlight, "utf8")).toHaveLength(4 * 1024 * 1024);
    await pending;
    await writer.write(late, "{}");
    expect(readdirSync(dir)).toEqual(["in-flight.meta.json"]);
  });

  it("close is idempotent", async () => {
    const writer = createWorkingTreeFileWriter();
    await writer.close();
    await expect(writer.close()).resolves.toBeUndefined();
  });
});

describe("reapAbandonedWorkingTreeTemps", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wt-temp-reap-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("removes the temp a process left when it exited mid-write, however fresh", async () => {
    const target = join(dir, "e.meta.json");
    // A real process writes its temp and exits before the rename.
    const child = spawnSync(process.execPath, [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(target)} + "." + process.pid + ".deadbeef.tmp", "{\\"half"); process.exit(0);`,
    ]);
    expect(child.status).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);

    const removed = await reapAbandonedWorkingTreeTemps(dir, { at: Date.now(), graceMs: HOUR });

    expect(removed).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps a fresh temp of a live process, removes it once older than the grace", async () => {
    const own = join(dir, `a.meta.json.${String(process.pid)}.0a0b0c0d.tmp`);
    writeFileSync(own, "{}");

    expect(await reapAbandonedWorkingTreeTemps(dir, { at: Date.now(), graceMs: HOUR })).toBe(0);
    expect(readdirSync(dir)).toHaveLength(1);

    const old = new Date(Date.now() - 2 * HOUR);
    utimesSync(own, old, old);
    expect(await reapAbandonedWorkingTreeTemps(dir, { at: Date.now(), graceMs: HOUR })).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("touches nothing that is not a temp, and only temps under the given prefix", async () => {
    const dead = deadPid();
    writeFileSync(join(dir, "a.meta.json"), "{}");
    writeFileSync(join(dir, "a.rows.json"), "[]");
    writeFileSync(join(dir, `.sweep-stamp.json.${String(dead)}.00ff00ff.tmp`), "{}");
    writeFileSync(join(dir, `.other-stamp.json.${String(dead)}.00ff00ff.tmp`), "{}");

    const removed = await reapAbandonedWorkingTreeTemps(dir, {
      at: Date.now(),
      graceMs: HOUR,
      prefix: ".sweep-stamp.json",
    });

    expect(removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      `.other-stamp.json.${String(dead)}.00ff00ff.tmp`,
      "a.meta.json",
      "a.rows.json",
    ]);
  });

  it("answers 0 for a directory that does not exist", async () => {
    expect(await reapAbandonedWorkingTreeTemps(join(dir, "missing"), { at: Date.now(), graceMs: HOUR })).toBe(0);
  });
});
