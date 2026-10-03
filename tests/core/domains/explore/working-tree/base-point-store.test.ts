/**
 * `createWorkingTreeBasePointStore` (bd tea-rags-mcp-xi2r9): the light tier of
 * the touched-file base points outlives the process, one record per index
 * revision. A record is exact to its revision, a read is its last use, and the
 * sweep holds the store to a read-idle window and a byte cap — touching nothing
 * outside its own directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createWorkingTreeBasePointStore,
  WORKING_TREE_BASE_POINT_RETENTION_MS,
} from "../../../../../src/core/domains/explore/working-tree/base-point-store.js";

const HOUR = 3_600_000;
const POINTS = new Map([
  ["src/a.ts", [{ id: "a1", payload: { relativePath: "src/a.ts", symbolId: "A", startLine: 1, endLine: 3 } }]],
  ["src/new.ts", []],
]);

describe("createWorkingTreeBasePointStore", () => {
  let rootDir: string;
  let clock: number;
  const store = (capBytes?: number) =>
    createWorkingTreeBasePointStore({ rootDir, now: () => clock, ...(capBytes ? { capBytes } : {}) });
  const storeDir = () => join(rootDir, ".base-points");
  const ageAll = (ms: number) => {
    for (const name of readdirSync(storeDir())) {
      const at = new Date(clock - ms);
      utimesSync(join(storeDir(), name), at, at);
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "wt-base-point-store-"));
    clock = Date.now();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("answers a revision another instance wrote, empty paths included, and misses any other revision", async () => {
    await store().write("rev-1", POINTS);

    expect(await store().read("rev-1")).toEqual(POINTS);
    expect(await store().read("rev-2")).toBeUndefined();
  });

  it("reads an unreadable, foreign or malformed record as a miss", async () => {
    await store().write("rev-1", POINTS);
    const [name] = readdirSync(storeDir());
    const path = join(storeDir(), name);

    writeFileSync(path, JSON.stringify({ format: 1, revision: "other", paths: {} }));
    expect(await store().read("rev-1")).toBeUndefined();
    writeFileSync(path, JSON.stringify({ format: 1, revision: "rev-1", paths: { "src/a.ts": [{ payload: {} }] } }));
    expect(await store().read("rev-1")).toBeUndefined();
    writeFileSync(path, "{not json");
    expect(await store().read("rev-1")).toBeUndefined();
  });

  it("drops a write it cannot land instead of rejecting", async () => {
    writeFileSync(storeDir(), "a file where the directory goes");

    await expect(store().write("rev-1", POINTS)).resolves.toBeUndefined();
    expect(await store().read("rev-1")).toBeUndefined();
  });

  it("evicts a record unread for the retention window and keeps one read inside it", async () => {
    await store().write("old", POINTS);
    ageAll(WORKING_TREE_BASE_POINT_RETENTION_MS + HOUR);
    await store().write("fresh", POINTS);

    const sweep = await store().sweep();

    expect(sweep.evicted).toBe(1);
    expect(await store().read("old")).toBeUndefined();
    expect(await store().read("fresh")).toEqual(POINTS);
  });

  it("evicts the least recently read records until the store fits its cap", async () => {
    await store().write("first", POINTS);
    await store().write("second", POINTS);
    ageAll(2 * HOUR);
    await store().read("second");
    const [one] = readdirSync(storeDir());
    const recordBytes = (await import("node:fs")).statSync(join(storeDir(), one)).size;

    await store(recordBytes + 1).sweep();

    expect(await store().read("first")).toBeUndefined();
    expect(await store().read("second")).toEqual(POINTS);
  });

  it("reaps a temp whose writer is gone and touches nothing outside its directory", async () => {
    mkdirSync(storeDir(), { recursive: true });
    writeFileSync(join(storeDir(), "abc.json.999999999.00ff.tmp"), "partial");
    writeFileSync(join(rootDir, "neighbour.json"), "{}");

    await store().sweep();

    expect(readdirSync(storeDir())).toEqual([]);
    expect(readdirSync(rootDir).sort()).toEqual([".base-points", "neighbour.json"]);
  });
});
