/**
 * The rules `purgeStaleSpills` applies, pinned without a pool (bd
 * tea-rags-mcp-v6gxr). Every pool construction runs this sweep over a directory
 * shared with every other pool on the same data dir — worker threads, the
 * daemon process, a second CLI run — so "what may be deleted" is the whole
 * contract, and it hangs on one predicate: does a live process still own it?
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { purgeStaleSpills, spillLiveMarkerPath } from "../../../../src/core/adapters/duckdb/spill-files.js";

/** A pid no probe should ever call alive; every test that needs one uses this. */
const DEAD_PID = 999_999;

describe("purgeStaleSpills", () => {
  let dir: string;

  const alive = (pid: number): boolean => pid !== DEAD_PID;

  /** Write a spill plus (optionally) the marker claiming it for `pid`. */
  function spill(name: string, pid?: number): string {
    const path = join(dir, `${name}.ndjson`);
    writeFileSync(path, '{"relPath":"a.ts"}\n');
    if (pid !== undefined) writeFileSync(spillLiveMarkerPath(path), String(pid));
    return path;
  }

  beforeEach(() => {
    dir = join(mkdtempSync(join(tmpdir(), "spill-files-")), ".spill");
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps a spill whose marker names a live process", () => {
    const live = spill("code_a-run1", process.pid);

    purgeStaleSpills(dir, alive);

    expect(existsSync(live)).toBe(true);
    expect(existsSync(spillLiveMarkerPath(live))).toBe(true);
  });

  it("removes a spill whose owner died mid-run, marker included", () => {
    const orphan = spill("code_a-run1", DEAD_PID);

    purgeStaleSpills(dir, alive);

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(spillLiveMarkerPath(orphan))).toBe(false);
  });

  it("removes an unclaimed spill — a crash before the marker, or a pre-marker build", () => {
    const unclaimed = spill("code_a-run1");

    purgeStaleSpills(dir, alive);

    expect(existsSync(unclaimed)).toBe(false);
  });

  it("ignores a marker written ahead of its spill, so the claim survives the open", () => {
    // The sink writes the marker BEFORE `createWriteStream`, and the fd opens a
    // few ticks later. A sweep landing in that window must not strip the claim.
    const pending = join(dir, "code_a-run1.ndjson");
    writeFileSync(spillLiveMarkerPath(pending), String(process.pid));

    purgeStaleSpills(dir, alive);

    expect(existsSync(spillLiveMarkerPath(pending))).toBe(true);
  });

  it("clears a marker whose owner died before the spill was ever opened", () => {
    // No spill to carry it out, so nothing else would ever reclaim it.
    const marker = spillLiveMarkerPath(join(dir, "code_a-run1.ndjson"));
    writeFileSync(marker, String(DEAD_PID));

    purgeStaleSpills(dir, alive);

    expect(existsSync(marker)).toBe(false);
  });

  it("sorts live from dead in one pass", () => {
    const live = spill("code_a-run1", process.pid);
    const dead = spill("code_b-run2", DEAD_PID);

    purgeStaleSpills(dir, alive);

    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
  });

  it("reclaims DuckDB temp files when no run is live in the directory", () => {
    const temp = join(dir, "duckdb_temp_storage-1.tmp");
    writeFileSync(temp, "spilled hash join\n");

    purgeStaleSpills(dir, alive);

    expect(existsSync(temp)).toBe(false);
  });

  it("leaves DuckDB temp files alone while a run is live", () => {
    // They carry no owner of their own, so a live spill is the only evidence
    // available that some process may still be spilling joins here.
    spill("code_a-run1", process.pid);
    const temp = join(dir, "duckdb_temp_storage-1.tmp");
    writeFileSync(temp, "spilled hash join\n");

    purgeStaleSpills(dir, alive);

    expect(existsSync(temp)).toBe(true);
  });

  it("recreates the directory so DuckDB's temp_directory has somewhere to point", () => {
    rmSync(dir, { recursive: true, force: true });

    purgeStaleSpills(dir, alive);

    expect(readdirSync(dir)).toEqual([]);
  });

  it("treats a corrupt marker as no claim at all", () => {
    const path = spill("code_a-run1");
    writeFileSync(spillLiveMarkerPath(path), "not-a-pid");

    purgeStaleSpills(dir, alive);

    expect(existsSync(path)).toBe(false);
  });

  it("defaults to a real signal-0 probe, which finds this process alive", () => {
    const live = spill("code_a-run1", process.pid);

    purgeStaleSpills(dir);

    expect(existsSync(live)).toBe(true);
  });
});
