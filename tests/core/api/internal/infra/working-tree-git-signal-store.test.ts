/**
 * `createWorkingTreeGitSignalStore` (bd tea-rags-mcp-xi2r9, live G2): the
 * on-demand git signals of delta files outlive the process. A record is exact
 * to its key, its read is its last use, and the sweep holds it to the chunk
 * store's 96 h window and a byte cap — touching nothing outside its own
 * directory.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createWorkingTreeGitSignalStore,
  scheduleWorkingTreeGitSignalSweep,
  WORKING_TREE_GIT_SIGNAL_RETENTION_MS,
} from "../../../../../src/core/api/internal/infra/working-tree-git-signal-store.js";

const HOUR = 3_600_000;
const RECORD = { file: { "12": { commitCount: 3 } }, chunks: { "abc:1-3": { commitCount: 2 }, "abc:5-7": null } };

describe("createWorkingTreeGitSignalStore", () => {
  let rootDir: string;
  let clock: number;
  const store = (capBytes?: number) =>
    createWorkingTreeGitSignalStore({ rootDir, now: () => clock, ...(capBytes ? { capBytes } : {}) });
  const storeDir = () => join(rootDir, ".git-signals");
  const ageAll = (ms: number) => {
    for (const name of readdirSync(storeDir())) {
      const at = new Date(clock - ms);
      utimesSync(join(storeDir(), name), at, at);
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "wt-git-signal-store-"));
    clock = Date.now();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("answers a record written by another instance — across processes — and misses any other key", async () => {
    await store().write("k1", RECORD);

    expect(await store().read("k1")).toEqual(RECORD);
    expect(await store().read("k2")).toBeUndefined();
  });

  it("reads an unreadable or foreign record as a miss", async () => {
    await store().write("k1", RECORD);
    const [name] = readdirSync(storeDir());
    writeFileSync(join(storeDir(), name), JSON.stringify({ format: 1, key: "other", file: {}, chunks: {} }));
    expect(await store().read("k1")).toBeUndefined();

    writeFileSync(join(storeDir(), name), "{not json");
    expect(await store().read("k1")).toBeUndefined();
  });

  it("evicts a record unread for the retention window and keeps one read since", async () => {
    await store().write("stale", RECORD);
    await store().write("fresh", RECORD);
    ageAll(WORKING_TREE_GIT_SIGNAL_RETENTION_MS + HOUR);
    // A read is a use: it restarts the record's window.
    expect(await store().read("fresh")).toEqual(RECORD);

    const sweep = await store().sweep();

    expect(sweep).toMatchObject({ evicted: 1, kept: 1 });
    expect(await store().read("stale")).toBeUndefined();
    expect(await store().read("fresh")).toEqual(RECORD);
  });

  it("evicts the least recently read records until the store fits its cap", async () => {
    await store().write("old", RECORD);
    ageAll(2 * HOUR);
    await store().write("new", RECORD);
    const oneRecord =
      readdirSync(storeDir()).length > 0 ? JSON.stringify({ format: 1, key: "new", ...RECORD }).length : 0;

    const sweep = await store(oneRecord + 1).sweep();

    expect(sweep).toMatchObject({ evicted: 1, kept: 1 });
    expect(await store().read("old")).toBeUndefined();
    expect(await store().read("new")).toEqual(RECORD);
  });

  it("sweeps on an unref'd schedule — after a delay a one-shot process never reaches, then every interval", () => {
    vi.useFakeTimers();
    try {
      const sweep = vi.fn(async () => ({ evicted: 0, kept: 0, bytes: 0 }));
      const stop = scheduleWorkingTreeGitSignalSweep({ sweep }, { initialDelayMs: 1_000, intervalMs: 10_000 });

      vi.advanceTimersByTime(999);
      expect(sweep).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(sweep).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(20_000);
      expect(sweep).toHaveBeenCalledTimes(3);

      stop();
      vi.advanceTimersByTime(50_000);
      expect(sweep).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps out of the collection directories beside it", async () => {
    mkdirSync(join(rootDir, "code_abc"), { recursive: true });
    writeFileSync(join(rootDir, "code_abc", "x.meta.json"), "{}");
    await store().write("k1", RECORD);
    ageAll(WORKING_TREE_GIT_SIGNAL_RETENTION_MS + HOUR);

    await store().sweep();

    expect(readdirSync(join(rootDir, "code_abc"))).toEqual(["x.meta.json"]);
  });
});
