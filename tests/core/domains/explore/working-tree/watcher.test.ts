/**
 * `WorkingTreeWatcher`: keeps an addressed tree's delta warm between requests in
 * the long-lived server. A recursive fs watch per tree root, debounced into one
 * `onSettled` call per burst, stopped when the root disappears, the tree goes
 * idle, the platform watcher fails, or the watcher closes. `fs.watch` is faked;
 * time runs on vitest fake timers.
 */
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  WORKING_TREE_WATCH_DEBOUNCE_MS,
  WORKING_TREE_WATCH_IDLE_MS,
  WorkingTreeWatcher,
  type WorkingTreeFsWatch,
  type WorkingTreeWatcherDeps,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const ROOT = "/repo/trees/feature";
const OTHER_ROOT = "/repo/trees/other";

class FakeFsWatchHandle extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
}

interface FakeWatch {
  root: string;
  emit: (eventType: string, filename: string | null) => void;
  handle: FakeFsWatchHandle;
}

function errnoError(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`${code}: fake`);
  error.code = code;
  return error;
}

interface Harness {
  watcher: WorkingTreeWatcher;
  watches: FakeWatch[];
  settled: string[];
  logs: string[];
  exists: Map<string, boolean>;
}

function harness(overrides: Partial<WorkingTreeWatcherDeps> = {}): Harness {
  const watches: FakeWatch[] = [];
  const settled: string[] = [];
  const logs: string[] = [];
  const exists = new Map<string, boolean>();
  const watch: WorkingTreeFsWatch = (root, listener) => {
    const handle = new FakeFsWatchHandle();
    watches.push({ root, emit: listener, handle });
    return handle;
  };
  const watcher = new WorkingTreeWatcher({
    watch,
    exists: async (root) => exists.get(root) ?? true,
    onSettled: (root) => {
      settled.push(root);
    },
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { watcher, watches, settled, logs, exists };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkingTreeWatcher", () => {
  it("defaults to a 2 s debounce and a 30 min idle stop", () => {
    expect(WORKING_TREE_WATCH_DEBOUNCE_MS).toBe(2000);
    expect(WORKING_TREE_WATCH_IDLE_MS).toBe(30 * 60 * 1000);
  });

  it("coalesces a burst into one onSettled, debounceMs after the last event", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    for (let i = 0; i < 5; i++) {
      h.watches[0].emit("change", `src/file-${i}.ts`);
      await vi.advanceTimersByTimeAsync(100);
    }
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS - 101);
    expect(h.settled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.settled).toEqual([ROOT]);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS * 3);
    expect(h.settled).toEqual([ROOT]);
  });

  it("ignores events under any .git segment", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", ".git/index");
    h.watches[0].emit("rename", "vendor/lib/.git/HEAD");
    h.watches[0].emit("change", ".git");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS * 2);
    expect(h.settled).toEqual([]);
  });

  it("does not mistake a .git-prefixed name for the .git directory", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", ".github/workflows/ci.yml");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([ROOT]);
  });

  it("drops paths the ingest filter rejects", async () => {
    const accepts = vi.fn(async () => (relativePath: string) => !relativePath.endsWith(".log"));
    const h = harness({ accepts });
    h.watcher.watch(ROOT);
    await vi.advanceTimersByTimeAsync(0);
    expect(accepts).toHaveBeenCalledWith(ROOT);
    h.watches[0].emit("change", "logs/out.log");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS * 2);
    expect(h.settled).toEqual([]);
    h.watches[0].emit("change", "src/a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([ROOT]);
  });

  it("counts an event with no filename as a relevant change", async () => {
    const h = harness({ accepts: async () => () => false });
    h.watcher.watch(ROOT);
    await vi.advanceTimersByTimeAsync(0);
    h.watches[0].emit("change", null);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([ROOT]);
  });

  it("stops a root idleMs after the last watch, and touch resets the clock", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_IDLE_MS - 1);
    h.watcher.touch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_IDLE_MS - 1);
    expect(h.watches[0].handle.closed).toBe(false);
    expect(h.watcher.isWatching(ROOT)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.watches[0].handle.closed).toBe(true);
    expect(h.watcher.isWatching(ROOT)).toBe(false);

    h.watches[0].emit("change", "src/a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([]);
  });

  it("re-watching a watched root resets its idle clock", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_IDLE_MS - 1);
    h.watcher.watch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_IDLE_MS - 1);
    expect(h.watches[0].handle.closed).toBe(false);
  });

  it("touch on an unwatched root starts nothing", async () => {
    const h = harness();
    h.watcher.touch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_IDLE_MS);
    expect(h.watches).toHaveLength(0);
    expect(h.watcher.isWatching(ROOT)).toBe(false);
  });

  it("honours custom debounceMs and idleMs", async () => {
    const h = harness({ debounceMs: 50, idleMs: 500 });
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "a.ts");
    await vi.advanceTimersByTimeAsync(50);
    expect(h.settled).toEqual([ROOT]);
    await vi.advanceTimersByTimeAsync(450);
    expect(h.watches[0].handle.closed).toBe(true);
  });

  it("stops when the root is gone at debounce time, without calling onSettled", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.exists.set(ROOT, false);
    h.watches[0].emit("change", "src/a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([]);
    expect(h.watches[0].handle.closed).toBe(true);
    expect(h.watcher.isWatching(ROOT)).toBe(false);
  });

  it("treats an event naming the root as a root event, not a content change", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "feature");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([]);
    expect(h.watcher.isWatching(ROOT)).toBe(true);
  });

  it("stops at once on a rename naming the root when the root is gone", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.exists.set(ROOT, false);
    h.watches[0].emit("rename", "feature");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.watches[0].handle.closed).toBe(true);
    expect(h.settled).toEqual([]);
  });

  it("stops on a watcher ENOENT error", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "src/a.ts");
    h.watches[0].handle.emit("error", errnoError("ENOENT"));
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.watches[0].handle.closed).toBe(true);
    expect(h.settled).toEqual([]);
  });

  it("stops that root alone on EMFILE and logs it", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watcher.watch(OTHER_ROOT);
    h.watches[0].handle.emit("error", errnoError("EMFILE"));
    expect(h.watches[0].handle.closed).toBe(true);
    expect(h.watches[1].handle.closed).toBe(false);
    expect(h.logs.some((line) => line.includes("EMFILE") && line.includes(ROOT))).toBe(true);
    h.watches[1].emit("change", "a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([OTHER_ROOT]);
  });

  it("logs and survives an fs.watch that throws at start", () => {
    const h = harness({
      watch: () => {
        throw errnoError("ENOSPC");
      },
    });
    expect(() => {
      h.watcher.watch(ROOT);
    }).not.toThrow();
    expect(h.watcher.isWatching(ROOT)).toBe(false);
    expect(h.logs.some((line) => line.includes("ENOSPC"))).toBe(true);
  });

  it("opens one fs watcher per root however often it is watched", () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watcher.watch(ROOT);
    h.watcher.watch(ROOT);
    expect(h.watches).toHaveLength(1);
    expect(h.watches[0].root).toBe(ROOT);
  });

  it("unwatch stops one root", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "a.ts");
    h.watcher.unwatch(ROOT);
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(h.settled).toEqual([]);
    expect(h.watches[0].handle.closed).toBe(true);
  });

  it("close stops everything and a pending debounce never fires", async () => {
    const h = harness();
    h.watcher.watch(ROOT);
    h.watcher.watch(OTHER_ROOT);
    h.watches[0].emit("change", "a.ts");
    h.watches[1].emit("change", "b.ts");
    h.watcher.close();
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS * 2);
    expect(h.settled).toEqual([]);
    expect(h.watches.every((w) => w.handle.closed)).toBe(true);
    h.watcher.watch(ROOT);
    expect(h.watches).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("swallows and logs an onSettled rejection, and keeps watching", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let calls = 0;
      const h = harness({
        onSettled: async () => {
          calls++;
          throw new Error("prewarm failed");
        },
      });
      h.watcher.watch(ROOT);
      h.watches[0].emit("change", "a.ts");
      await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
      expect(calls).toBe(1);
      expect(h.logs.some((line) => line.includes("prewarm failed"))).toBe(true);
      h.watches[0].emit("change", "b.ts");
      await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(0);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("never overlaps onSettled for a root; debounces during a run coalesce into one rerun", async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let maxRunning = 0;
    const h = harness({
      onSettled: async () =>
        new Promise<void>((resolve) => {
          running++;
          maxRunning = Math.max(maxRunning, running);
          releases.push(() => {
            running--;
            resolve();
          });
        }),
    });
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(releases).toHaveLength(1);

    h.watches[0].emit("change", "b.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    h.watches[0].emit("change", "c.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(releases).toHaveLength(1);

    releases[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(2);

    releases[1]();
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(releases).toHaveLength(2);
    expect(maxRunning).toBe(1);
  });

  it("logs a failing existence check on a root rename instead of rejecting", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const h = harness({
        exists: async () => {
          throw errnoError("EACCES");
        },
      });
      h.watcher.watch(ROOT);
      h.watches[0].emit("rename", "feature");
      await vi.advanceTimersByTimeAsync(0);
      expect(h.logs.some((line) => line.includes("EACCES"))).toBe(true);
      await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
      expect(h.settled).toEqual([]);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("unrefs every timer it arms so it never keeps the process alive", async () => {
    const unrefs: ReturnType<typeof vi.fn>[] = [];
    let armed = 0;
    const h = harness({
      timers: {
        setTimeout: (callback, ms) => {
          armed++;
          const handle = setTimeout(callback, ms);
          const unref = vi.fn(() => handle);
          unrefs.push(unref);
          return Object.assign(handle, { unref });
        },
        clearTimeout: (handle) => {
          clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
        },
      },
    });
    h.watcher.watch(ROOT);
    h.watches[0].emit("change", "a.ts");
    await vi.advanceTimersByTimeAsync(WORKING_TREE_WATCH_DEBOUNCE_MS);
    expect(armed).toBeGreaterThanOrEqual(2);
    expect(unrefs).toHaveLength(armed);
    expect(unrefs.every((unref) => unref.mock.calls.length === 1)).toBe(true);
  });
});

describe("WorkingTreeWatcher on the real file system", () => {
  let dir: string;

  beforeEach(() => {
    vi.useRealTimers();
    dir = mkdtempSync(join(tmpdir(), "wt-watcher-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, ".git"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition() && Date.now() < deadline) await realDelay(25);
  }

  it("settles on a nested edit through the default recursive fs.watch, ignoring .git", async () => {
    const settled: string[] = [];
    const watcher = new WorkingTreeWatcher({
      debounceMs: 100,
      onSettled: (root) => {
        settled.push(root);
      },
    });
    try {
      watcher.watch(dir);
      // macOS FSEvents replays entries created just before the watch began
      // (the fixture's mkdirs); let that settle before measuring.
      await realDelay(400);
      settled.length = 0;
      writeFileSync(join(dir, ".git", "index"), "x");
      await realDelay(400);
      expect(settled).toEqual([]);
      writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
      await waitFor(() => settled.length > 0);
      expect(settled).toEqual([dir]);
    } finally {
      watcher.close();
    }
  });

  it("stops once the root is removed", async () => {
    const watcher = new WorkingTreeWatcher({ debounceMs: 100, onSettled: () => undefined });
    try {
      watcher.watch(dir);
      await realDelay(100);
      writeFileSync(join(dir, "src", "a.ts"), "1");
      rmSync(dir, { recursive: true, force: true });
      await waitFor(() => !watcher.isWatching(dir));
      expect(watcher.isWatching(dir)).toBe(false);
    } finally {
      watcher.close();
    }
  });
});
